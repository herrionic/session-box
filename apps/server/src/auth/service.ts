import { createHash, randomBytes } from "node:crypto";
import { newApiTokenId, newSessionId, newUserId, nowIso } from "@sessionbox/shared";
import { SessionBoxError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type {
  ApiTokenRecord,
  ApiTokenRepository,
  SessionRepository,
  UserRecord,
  UserRepository,
} from "../storage/user-repository.ts";
import { ALL_PERMISSIONS } from "./config.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import type { Principal } from "./principals.ts";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
}

export interface PublicApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AuthServiceOptions {
  users: UserRepository;
  sessions: SessionRepository;
  tokens: ApiTokenRepository;
  logger: Logger;
  /** Session lifetime; defaults to 30 days. */
  sessionTtlMs?: number;
  now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const API_TOKEN_PREFIX = "sbt_";

/**
 * Single-owner authentication: one user account (created from the environment
 * on first start), session cookies for the web UI and API tokens for plugins.
 * Password hashes are scrypt; API tokens are stored as SHA-256 hashes.
 */
export class AuthService {
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly tokens: ApiTokenRepository;
  private readonly logger: Logger;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private enforcedFlag = false;

  constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.tokens = options.tokens;
    this.logger = options.logger;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** True when an owner account exists and the API must be authenticated. */
  get enforced(): boolean {
    return this.enforcedFlag;
  }

  /** True while no owner account exists (the setup wizard handles it). */
  async needsSetup(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  /**
   * Creates the owner account from the setup wizard. Refuses once an owner
   * exists, which is what lets the endpoint stay public.
   */
  async completeSetup(username: string, displayName: string, password: string): Promise<PublicUser> {
    if (!(await this.needsSetup())) {
      throw new SessionBoxError("INVALID_STATE", "setup has already been completed");
    }
    return await this.createOwner(username, displayName, password);
  }

  /**
   * Optional environment-based seeding for automated deployments. Without a
   * password the instance waits for the setup wizard instead.
   */
  async ensureOwner(username: string, password: string | undefined): Promise<void> {
    if (!(await this.needsSetup())) {
      this.enforcedFlag = true;
      return;
    }

    if (password === undefined || password === "") {
      this.logger.info(
        { event: "auth.setup.pending" },
        "no owner account yet; the web UI shows the setup wizard on first visit",
      );
      return;
    }

    await this.createOwner(username, username, password);
  }

  private async createOwner(
    username: string,
    displayName: string,
    password: string,
  ): Promise<PublicUser> {
    const now = nowIso(this.now());
    const user: UserRecord = {
      id: newUserId(),
      username,
      displayName,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    await this.users.create(user);
    this.enforcedFlag = true;
    this.logger.info({ event: "auth.owner.created", username }, "owner account created");
    return toPublicUser(user);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ sessionId: string; expiresAt: string; user: PublicUser } | undefined> {
    const user = await this.users.getByUsername(username);
    if (user === undefined) return undefined;
    if (!(await verifyPassword(password, user.passwordHash))) return undefined;

    const createdAt = nowIso(this.now());
    const sessionId = newSessionId();
    const expiresAt = new Date(this.now() + this.sessionTtlMs).toISOString();
    await this.sessions.create({ id: sessionId, userId: user.id, createdAt, expiresAt });
    void this.sessions.deleteExpired(createdAt).catch(() => {});

    this.logger.info({ event: "auth.login", userId: user.id }, "user logged in");
    return { sessionId, expiresAt, user: toPublicUser(user) };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.delete(sessionId);
  }

  /** Resolves a session cookie to a user principal (expired sessions dropped). */
  async resolveSession(sessionId: string): Promise<Principal | undefined> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined) return undefined;

    if (Date.parse(session.expiresAt) <= this.now()) {
      await this.sessions.delete(sessionId);
      return undefined;
    }

    const user = await this.users.getById(session.userId);
    if (user === undefined) return undefined;
    return { id: user.id, type: "user", permissions: [ALL_PERMISSIONS] };
  }

  /** Resolves an API token (only tokens with the `sbt_` prefix reach the DB). */
  async authenticateToken(token: string): Promise<Principal | undefined> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return undefined;

    const record = await this.tokens.findByHash(hashToken(token));
    if (record === undefined) return undefined;

    await this.tokens.touch(record.id, nowIso(this.now()));
    return { id: `token:${record.id}`, type: "plugin", permissions: [ALL_PERMISSIONS] };
  }

  async getUser(userId: string): Promise<PublicUser | undefined> {
    const user = await this.users.getById(userId);
    return user === undefined ? undefined : toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    patch: { username?: string; displayName?: string },
  ): Promise<PublicUser> {
    const user = await this.users.getById(userId);
    if (user === undefined) throw new SessionBoxError("NOT_FOUND", "user not found");

    const username = patch.username ?? user.username;
    const displayName = patch.displayName ?? user.displayName;
    await this.users.updateProfile(userId, { username, displayName }, nowIso(this.now()));
    this.logger.info(
      { event: "auth.profile.updated", userId, usernameChanged: patch.username !== undefined },
      "profile updated",
    );
    return { id: user.id, username, displayName };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.getById(userId);
    if (user === undefined) throw new SessionBoxError("NOT_FOUND", "user not found");

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new SessionBoxError("INVALID_REQUEST", "current password is incorrect");
    }

    await this.users.updatePassword(userId, await hashPassword(newPassword), nowIso(this.now()));
    this.logger.info({ event: "auth.password.changed", userId }, "password changed");
  }

  /** Creates an API token; the plaintext is returned exactly once. */
  async createToken(userId: string, name: string): Promise<{ token: string; entry: PublicApiToken }> {
    const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
    const record: ApiTokenRecord = {
      id: newApiTokenId(),
      userId,
      name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      createdAt: nowIso(this.now()),
    };
    await this.tokens.create(record);
    return { token, entry: toPublicToken(record) };
  }

  async listTokens(userId: string): Promise<PublicApiToken[]> {
    return (await this.tokens.listByUser(userId)).map(toPublicToken);
  }

  async revokeToken(userId: string, id: string): Promise<boolean> {
    return await this.tokens.delete(userId, id);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function toPublicToken(record: ApiTokenRecord): PublicApiToken {
  return {
    id: record.id,
    name: record.name,
    prefix: record.tokenPrefix,
    createdAt: record.createdAt,
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}
