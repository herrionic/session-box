import type { DatabaseSync } from "node:sqlite";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface UserRepository {
  count(): Promise<number>;
  create(user: UserRecord): Promise<void>;
  getByUsername(username: string): Promise<UserRecord | undefined>;
  getById(id: string): Promise<UserRecord | undefined>;
  updateDisplayName(id: string, displayName: string, updatedAt: string): Promise<void>;
  updatePassword(id: string, passwordHash: string, updatedAt: string): Promise<void>;
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  delete(id: string): Promise<void>;
  deleteExpired(before: string): Promise<void>;
}

export interface ApiTokenRepository {
  create(token: ApiTokenRecord): Promise<void>;
  listByUser(userId: string): Promise<ApiTokenRecord[]>;
  findByHash(tokenHash: string): Promise<ApiTokenRecord | undefined>;
  delete(userId: string, id: string): Promise<boolean>;
  touch(id: string, at: string): Promise<void>;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly database: DatabaseSync) {}

  async count(): Promise<number> {
    const row = this.database.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  async create(user: UserRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, user.username, user.displayName, user.passwordHash, user.createdAt, user.updatedAt);
  }

  async getByUsername(username: string): Promise<UserRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  async getById(id: string): Promise<UserRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  async updateDisplayName(id: string, displayName: string, updatedAt: string): Promise<void> {
    this.database
      .prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName, updatedAt, id);
  }

  async updatePassword(id: string, passwordHash: string, updatedAt: string): Promise<void> {
    this.database
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, updatedAt, id);
  }
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  async create(session: SessionRecord): Promise<void> {
    this.database
      .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(session.id, session.userId, session.createdAt, session.expiresAt);
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const row = this.database
      .prepare("SELECT id, user_id, created_at, expires_at FROM sessions WHERE id = ?")
      .get(id) as
      | { id: string; user_id: string; created_at: string; expires_at: string }
      | undefined;
    if (row === undefined) return undefined;
    return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  async delete(id: string): Promise<void> {
    this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async deleteExpired(before: string): Promise<void> {
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(before);
  }
}

export class SqliteApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly database: DatabaseSync) {}

  async create(token: ApiTokenRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(token.id, token.userId, token.name, token.tokenHash, token.tokenPrefix, token.createdAt);
  }

  async listByUser(userId: string): Promise<ApiTokenRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as unknown as TokenRow[];
    return rows.map(toToken);
  }

  async findByHash(tokenHash: string): Promise<ApiTokenRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(tokenHash) as
      | TokenRow
      | undefined;
    return row === undefined ? undefined : toToken(row);
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const result = this.database
      .prepare("DELETE FROM api_tokens WHERE user_id = ? AND id = ?")
      .run(userId, id);
    return result.changes > 0;
  }

  async touch(id: string, at: string): Promise<void> {
    this.database.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(at, id);
  }
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toToken(row: TokenRow): ApiTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
  };
}
