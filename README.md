# SessionBox

**为 Coding Agent 提供独立的 Linux 执行环境。**

Agent 可以在容器里安装依赖、修改配置、运行代码。环境出了问题，可以重建容器继续使用。多个 Agent 协作时，可以各用一个容器，并加入同一个网络，让容器中的服务互相访问。

SessionBox 提供容器、网络和工具接入能力，可作为 multi-agent 系统的执行环境底座。

## 功能

- **独立环境**：每个容器有自己的文件系统和运行环境，基础镜像提供免密 `sudo`，方便安装系统依赖。
- **容器管理**：创建、启动、停止、重启和删除容器；配置资源限制、空闲停止和最长运行时间。
- **网络协作**：默认分配独立网络，也可将多个容器加入共享网络。
- **Agent 接入**：通过插件将文件操作和 shell 命令转发到容器，按会话选择执行目标。
- **Web 管理**：管理容器和网络、浏览文件、打开终端，手动检查或接管环境。
- **账号与 Token**：支持账号登录和 API Token，供插件连接服务端。

目前主要使用和验证的是 DSH 插件（[独立仓库](https://github.com/herrionic/dsh-session-box)）。当前通过源码和 Docker Compose 部署。

## 快速启动

### 环境要求

服务端运行在 Linux Docker 主机上，需要：

- Docker Engine
- Docker Compose

可以使用本机 Linux 环境或远程服务器。

获取源码后，在仓库根目录执行：

```bash
docker build -t sessionbox/base:latest images/base
docker compose up -d --build
```

打开 <http://localhost:8787>，按页面提示创建管理员账号。远程部署时，将 `localhost` 换成 Docker 主机地址。

默认无需创建 `.env`，服务端会自动生成并保存加密密钥。需要调整配置时，参考 [`.env.example`](.env.example)。

服务端状态保存在 `sessionbox-data` 数据卷中。

查看日志：

```bash
docker compose logs -f server
```

> 服务端通过主机的 Docker socket 管理容器，拥有较高的主机权限。请限制管理服务的访问范围，并使用账号认证。

## 接入 Coding Agent

Agent 客户端运行在本机；插件连接 SessionBox，将支持的工具操作转发到选定容器。服务端可以部署在另一台机器上。

### DSH

当前插件适配 `@deepseek-ai/dsh-*` 的 `0.2.0-rc.2` 版本，位于独立仓库：
<https://github.com/herrionic/dsh-session-box>（安装方式见仓库说明）。

1. 在 Web 页面创建容器。
2. 在账号设置中创建 API Token。
3. 按独立仓库的说明构建并安装插件。
4. 在 DSH 会话中选择容器。

配置项：

| 配置 | 说明 |
| --- | --- |
| `baseUrl` | SessionBox 服务地址，例如 `http://localhost:8787` |
| `tokenRef` | API Token 的凭据引用，默认 `SESSIONBOX_TOKEN`；通过插件设置表单保存 Token |
| `containerRoot` | 容器内的工作目录，默认 `/workspace` |

在会话中执行：

```text
/sessionbox             # 查看当前目标和可选容器
/sessionbox backend     # 绑定到名为 backend 的容器
/sessionbox host        # 切回本机
```

也可以通过输入框旁的容器选择器切换。

绑定按会话生效。插件连接已创建的容器，绑定时不会自动创建容器。

本机工作目录与容器的 `/workspace` 不会自动同步，已有项目需要先放入容器。

更多配置和工具转发范围见 [DSH 插件仓库](https://github.com/herrionic/dsh-session-box)。

## 多容器协作

例如，两个 Agent 分别使用 `backend` 和 `frontend` 容器：

1. 在网络管理页面创建共享网络。
2. 创建容器时选择该网络，或将已有容器加入网络。
3. 后端服务在 `backend` 中监听 `0.0.0.0:8080`。
4. `frontend` 中的程序通过 `http://backend:8080` 访问后端。

共享网络内使用对方的容器名称通信。`localhost` 始终指向当前容器。

各容器保留自己的文件系统。共享网络提供服务互访能力；文件传递、任务分配和 Agent 协作流程由使用方或上层系统组织。加入共享网络不会自动将服务端口发布到主机。

## 隔离与权限

Agent 容器默认不挂载主机目录或 Docker socket。容器中的 `agent` 用户可通过免密 `sudo` 安装软件和修改环境。

这种设计主要用于将开发中的环境变更和误操作限制在容器内。容器共享主机内核，不应将其视为运行恶意代码的安全边界。

Agent 客户端及其他未接管的工具仍运行在本机。DSH 插件对工作目录外路径、部分后台观察器和未配置转发的子进程存在接管范围限制，使用前请查看 [插件说明](https://github.com/herrionic/dsh-session-box)。

## 开发

需要 Node.js 24+、仓库指定版本的 pnpm，以及可用于实际容器操作的 Docker 环境。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

另开一个终端启动前端：

```bash
pnpm dev:web
```

- API：<http://localhost:8787>
- Web：<http://localhost:5173>

检查代码：

```bash
pnpm typecheck
pnpm test
```

单元测试和 FakeRuntime HTTP 测试可在没有 Docker 的情况下运行。实际容器、SSH/SFTP 和终端操作需要 Docker。

也可通过开发 Compose 配置启动：

```bash
docker compose -f docker-compose.yml -f compose.dev.yml up -d --build
```

### 项目结构

| 目录 | 内容 |
| --- | --- |
| `apps/server` | API、容器管理、SSH/SFTP、认证和数据存储 |
| `apps/web` | Web 管理页面、文件浏览和终端 |
| `packages/protocol` | API 与 Agent 协议定义 |
| `packages/client` | 插件使用的客户端 |
| `packages/shared` | 公共辅助代码 |
| `images/base` | 容器基础镜像 |

## 文档

- [DSH 插件](https://github.com/herrionic/dsh-session-box)
- [集成说明](docs/INTEGRATION.md)
- [协议说明](docs/PROTOCOL.md)

## 参与贡献

欢迎提交问题和改进建议。报告问题时，请附上版本、部署方式、复现步骤和相关日志，并移除日志中的 Token 与其他私密信息。

开发前请阅读 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)
