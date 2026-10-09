import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

export type Locale = "en" | "zh";

export const LOCALE_STORAGE_KEY = "sessionbox.locale";

const en = {
  "app.loading": "Loading…",
  "app.tagline": "containers as session runtime",

  "nav.containers": "Containers",
  "nav.networks": "Networks",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.language": "Language",

  "login.username": "Username",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.signingIn": "Signing in…",

  "setup.title": "Welcome to SessionBox",
  "setup.subtitle":
    "Create the owner account. This wizard appears only once — afterwards you sign in normally.",
  "setup.username": "Username",
  "setup.displayName": "Display name",
  "setup.displayNameHint": "Optional",
  "setup.password": "Password",
  "setup.passwordHint": "At least 8 characters",
  "setup.repeatPassword": "Repeat password",
  "setup.mismatch": "Passwords do not match.",
  "setup.submit": "Create account and continue",
  "setup.submitting": "Creating…",

  "common.cancel": "Cancel",
  "common.create": "Create",
  "common.creating": "Creating…",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.saved": "Saved",
  "common.delete": "Delete",
  "common.download": "Download",
  "common.refresh": "Refresh",
  "common.upload": "Upload",
  "common.close": "Close",
  "common.actions": "Actions",
  "common.name": "Name",
  "common.created": "Created",
  "common.never": "never",
  "common.unlimited": "unlimited",

  "containers.title": "Containers",
  "containers.subtitle": "Every agent session runs in its own container.",
  "containers.new": "New container",
  "containers.empty": "No containers yet — create one to get started.",
  "containers.colStatus": "Status",
  "containers.colImage": "Image",
  "containers.colResources": "Resources",
  "containers.deleteConfirm": 'Delete container "{name}"? This cannot be undone.',
  "containers.open": "Open",
  "containers.start": "Start",
  "containers.stop": "Stop",
  "containers.restart": "Restart",

  "container.back": "← All containers",
  "container.backShort": "Back to containers",
  "container.tab.overview": "Overview",
  "container.tab.files": "Files",
  "container.tab.terminal": "Terminal",
  "container.tab.network": "Network",
  "container.overview": "Overview",
  "container.image": "Image",
  "container.runtime": "Runtime",
  "container.workspace": "Workspace",
  "container.resources": "Resources",
  "container.created": "Created",
  "container.started": "Started",
  "container.stopped": "Stopped",
  "container.lastActivity": "Last activity",
  "container.activeConnections": "Active connections",
  "container.lifecycle": "Lifecycle",
  "container.autoStop": "Automatic stop",
  "container.idleTimeout": "Idle timeout (minutes)",
  "container.idleTimeoutHint": "Stop after this long without activity",
  "container.maxLifetime": "Maximum lifetime (minutes)",
  "container.maxLifetimeHint": "Optional hard limit",
  "container.deleteAfterStop": "Delete after stop",
  "container.saveLifecycle": "Save lifecycle",
  "container.lifecycleNote":
    "Lifecycle is enforced by SessionBox, not by the agent. A plugin disconnect never stops the container.",

  "newContainer.title": "New container",
  "newContainer.subtitle": "Created from the base image and started immediately.",
  "newContainer.identity": "Identity",
  "newContainer.name": "Name",
  "newContainer.nameHint": "Optional — letters, digits, . _ -",
  "newContainer.image": "Image",
  "newContainer.imageHint": "Defaults to sessionbox/base:latest",
  "newContainer.resources": "Resources",
  "newContainer.cpu": "CPU (cores)",
  "newContainer.memory": "Memory (MB)",
  "newContainer.pids": "PIDs limit",
  "newContainer.networks": "Networks",
  "newContainer.networksHint":
    "The default network is always attached. Pick shared networks so this container can reach — and be reached by — other sessions by name.",
  "newContainer.networksEmpty": "No shared networks yet — create one on the Networks page.",
  "newContainer.lifecycle": "Lifecycle",
  "newContainer.create": "Create container",

  "networks.title": "Networks",
  "networks.subtitle":
    "Containers on the same network reach each other by name. The default network is always attached to every container.",
  "networks.new": "New network",
  "networks.empty": "No shared networks yet — create one to connect containers across sessions.",
  "networks.colContainers": "Containers",
  "networks.deleteConfirm": 'Delete network "{name}"?',
  "networks.modalTitle": "New network",
  "networks.nameHint": "Letters, digits, . _ - (e.g. team-a)",
  "networks.create": "Create network",

  "settings.title": "Settings",
  "settings.subtitle": "Profile, password and API tokens for plugins.",
  "settings.profile": "Profile",
  "settings.username": "Username",
  "settings.usernameHint": "Used to sign in",
  "settings.displayName": "Display name",
  "settings.saveProfile": "Save profile",
  "settings.profileSaved": "Profile updated.",
  "settings.password": "Password",
  "settings.currentPassword": "Current password",
  "settings.newPassword": "New password",
  "settings.newPasswordHint": "At least 8 characters",
  "settings.repeatNewPassword": "Repeat new password",
  "settings.passwordMismatch": "New passwords do not match.",
  "settings.changePassword": "Change password",
  "settings.passwordChanged": "Password changed.",
  "settings.tokens": "API tokens",
  "settings.tokensHint": "Tokens authenticate the Pi / DSH plugins. The plaintext is shown exactly once.",
  "settings.newToken": "New token — copy it now, it will not be shown again",
  "settings.tokenName": "Token name",
  "settings.generateToken": "Generate token",
  "settings.generating": "Generating…",
  "settings.colPrefix": "Prefix",
  "settings.colLastUsed": "Last used",
  "settings.tokensEmpty": "No tokens yet.",
  "settings.revoke": "Revoke",
  "settings.revokeConfirm": 'Revoke token "{name}"? Plugins using it lose access.',

  "files.newFile": "New file",
  "files.newFolder": "New folder",
  "files.empty": "This directory is empty.",
  "files.colSize": "Size",
  "files.colModified": "Modified",
  "files.newFileName": "New file name",
  "files.newFolderName": "New folder name",
  "files.deleteConfirm": "Delete {path}?",

  "terminal.title": "Terminal",
  "terminal.reconnect": "Reconnect",
  "terminal.connecting": "connecting",
  "terminal.connected": "connected",
  "terminal.closed": "closed",
  "terminal.error": "error",
  "terminal.exited": "[process exited with code {code}]",

  "network.private": "private · always attached",
  "network.oneContainer": "1 container",
  "network.manyContainers": "{count} containers",
  "network.detach": "Detach",
  "network.loading": "Loading networks…",
  "network.none": "No shared networks available to attach.",
  "network.attachTo": "Attach to network",
  "network.select": "Select a network…",
  "network.attach": "Attach",
  "network.note":
    "Every container gets its own private network, so containers cannot reach each other by default. Attach two containers to the same shared network to let them connect by name across sessions.",
  "network.createOne": "Create a network",

  "status.running": "running",
  "status.stopped": "stopped",
  "status.creating": "creating",
  "status.deleting": "deleting",
  "status.failed": "failed",
} as const;

export type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const zh: Messages = {
  "app.loading": "加载中…",
  "app.tagline": "以容器作为会话运行时",

  "nav.containers": "容器",
  "nav.networks": "网络",
  "nav.settings": "设置",
  "nav.signOut": "退出登录",
  "nav.language": "语言",

  "login.username": "用户名",
  "login.password": "密码",
  "login.signIn": "登录",
  "login.signingIn": "登录中…",

  "setup.title": "欢迎使用 SessionBox",
  "setup.subtitle": "创建所有者账户。此向导只出现一次——之后正常登录即可。",
  "setup.username": "用户名",
  "setup.displayName": "显示名称",
  "setup.displayNameHint": "可选",
  "setup.password": "密码",
  "setup.passwordHint": "至少 8 个字符",
  "setup.repeatPassword": "重复密码",
  "setup.mismatch": "两次输入的密码不一致。",
  "setup.submit": "创建账户并继续",
  "setup.submitting": "创建中…",

  "common.cancel": "取消",
  "common.create": "创建",
  "common.creating": "创建中…",
  "common.save": "保存",
  "common.saving": "保存中…",
  "common.saved": "已保存",
  "common.delete": "删除",
  "common.download": "下载",
  "common.refresh": "刷新",
  "common.upload": "上传",
  "common.close": "关闭",
  "common.actions": "操作",
  "common.name": "名称",
  "common.created": "创建时间",
  "common.never": "从未",
  "common.unlimited": "不限制",

  "containers.title": "容器",
  "containers.subtitle": "每个 agent 会话都在自己的容器中运行。",
  "containers.new": "新建容器",
  "containers.empty": "还没有容器——新建一个开始使用。",
  "containers.colStatus": "状态",
  "containers.colImage": "镜像",
  "containers.colResources": "资源",
  "containers.deleteConfirm": "删除容器“{name}”？此操作不可撤销。",
  "containers.open": "打开",
  "containers.start": "启动",
  "containers.stop": "停止",
  "containers.restart": "重启",

  "container.back": "← 所有容器",
  "container.backShort": "返回容器列表",
  "container.tab.overview": "概览",
  "container.tab.files": "文件",
  "container.tab.terminal": "终端",
  "container.tab.network": "网络",
  "container.overview": "概览",
  "container.image": "镜像",
  "container.runtime": "运行时",
  "container.workspace": "工作区",
  "container.resources": "资源",
  "container.created": "创建时间",
  "container.started": "启动时间",
  "container.stopped": "停止时间",
  "container.lastActivity": "最近活动",
  "container.activeConnections": "活动连接",
  "container.lifecycle": "生命周期",
  "container.autoStop": "自动停止",
  "container.idleTimeout": "空闲超时（分钟）",
  "container.idleTimeoutHint": "空闲超过该时长后停止",
  "container.maxLifetime": "最长存活（分钟）",
  "container.maxLifetimeHint": "可选的硬性上限",
  "container.deleteAfterStop": "停止后删除",
  "container.saveLifecycle": "保存生命周期设置",
  "container.lifecycleNote": "生命周期由 SessionBox（而非 agent）执行。插件断开不会停止容器。",

  "newContainer.title": "新建容器",
  "newContainer.subtitle": "基于基础镜像创建并立即启动。",
  "newContainer.identity": "基本信息",
  "newContainer.name": "名称",
  "newContainer.nameHint": "可选——字母、数字、. _ -",
  "newContainer.image": "镜像",
  "newContainer.imageHint": "默认为 sessionbox/base:latest",
  "newContainer.resources": "资源",
  "newContainer.cpu": "CPU（核）",
  "newContainer.memory": "内存（MB）",
  "newContainer.pids": "进程数上限",
  "newContainer.networks": "网络",
  "newContainer.networksHint":
    "默认网络始终挂载。选择共享网络后，此容器可按名称访问（及被访问）其他会话。",
  "newContainer.networksEmpty": "还没有共享网络——请到“网络”页面创建。",
  "newContainer.lifecycle": "生命周期",
  "newContainer.create": "创建容器",

  "networks.title": "网络",
  "networks.subtitle": "同一网络中的容器可按名称互相访问。默认网络始终挂载到每个容器。",
  "networks.new": "新建网络",
  "networks.empty": "还没有共享网络——创建一个即可跨会话连接容器。",
  "networks.colContainers": "容器",
  "networks.deleteConfirm": "删除网络“{name}”？",
  "networks.modalTitle": "新建网络",
  "networks.nameHint": "字母、数字、. _ -（例如 team-a）",
  "networks.create": "创建网络",

  "settings.title": "设置",
  "settings.subtitle": "个人资料、密码与供插件使用的 API 令牌。",
  "settings.profile": "个人资料",
  "settings.username": "用户名",
  "settings.usernameHint": "用于登录",
  "settings.displayName": "显示名称",
  "settings.saveProfile": "保存资料",
  "settings.profileSaved": "资料已更新。",
  "settings.password": "密码",
  "settings.currentPassword": "当前密码",
  "settings.newPassword": "新密码",
  "settings.newPasswordHint": "至少 8 个字符",
  "settings.repeatNewPassword": "重复新密码",
  "settings.passwordMismatch": "两次输入的新密码不一致。",
  "settings.changePassword": "修改密码",
  "settings.passwordChanged": "密码已修改。",
  "settings.tokens": "API 令牌",
  "settings.tokensHint": "令牌用于 Pi / DSH 插件认证。明文只显示一次。",
  "settings.newToken": "新令牌——请立即复制，之后不再显示",
  "settings.tokenName": "令牌名称",
  "settings.generateToken": "生成令牌",
  "settings.generating": "生成中…",
  "settings.colPrefix": "前缀",
  "settings.colLastUsed": "最近使用",
  "settings.tokensEmpty": "还没有令牌。",
  "settings.revoke": "吊销",
  "settings.revokeConfirm": "吊销令牌“{name}”？使用它的插件将失去访问权限。",

  "files.newFile": "新建文件",
  "files.newFolder": "新建文件夹",
  "files.empty": "此目录为空。",
  "files.colSize": "大小",
  "files.colModified": "修改时间",
  "files.newFileName": "新文件名",
  "files.newFolderName": "新文件夹名称",
  "files.deleteConfirm": "删除 {path}？",

  "terminal.title": "终端",
  "terminal.reconnect": "重新连接",
  "terminal.connecting": "连接中",
  "terminal.connected": "已连接",
  "terminal.closed": "已断开",
  "terminal.error": "错误",
  "terminal.exited": "[进程已退出，退出码 {code}]",

  "network.private": "私有 · 始终挂载",
  "network.oneContainer": "1 个容器",
  "network.manyContainers": "{count} 个容器",
  "network.detach": "断开",
  "network.loading": "正在加载网络…",
  "network.none": "没有可挂载的共享网络。",
  "network.attachTo": "挂载到网络",
  "network.select": "选择一个网络…",
  "network.attach": "挂载",
  "network.note":
    "每个容器都有自己的私有网络，默认互不可达。将两个容器挂载到同一共享网络后，它们即可跨会话按名称互连。",
  "network.createOne": "创建网络",

  "status.running": "运行中",
  "status.stopped": "已停止",
  "status.creating": "创建中",
  "status.deleting": "删除中",
  "status.failed": "失败",
};

export const messages: Record<Locale, Messages> = { en, zh };

/** Fills `{name}` placeholders; unknown keys fall back to English, then the key. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = messages[locale][key] ?? messages.en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}

/**
 * Stored choice wins; otherwise the browser languages decide (zh* → Chinese,
 * en* → English), with English as the final fallback.
 */
export function resolveLocale(
  stored: string | null | undefined,
  languages: readonly string[],
): Locale {
  if (stored === "en" || stored === "zh") return stored;
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n | null>(null);

function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function detectLocale(): Locale {
  const languages =
    typeof navigator === "undefined"
      ? []
      : (navigator.languages ?? [navigator.language]).filter(
          (language): language is string => typeof language === "string",
        );
  return resolveLocale(readStoredLocale(), languages);
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const setLocale = useCallback((next: Locale): void => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Private mode without storage: the choice lasts for this tab only.
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>): string =>
      translate(locale, key, params),
    [locale],
  );

  const value = useMemo<I18n>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used inside an I18nProvider");
  }
  return value;
}
