# 发布 GHCR 镜像

仓库的 `.github/workflows/publish-images.yml` 在 GitHub 托管的 Ubuntu runner 上构建并发布：

| 镜像 | 构建上下文 | 内容 |
| --- | --- | --- |
| `ghcr.io/herrionic/session-box` | 仓库根目录 | 服务端与 Web UI |
| `ghcr.io/herrionic/session-box-base` | `images/base` | Agent Linux 环境与 SSH |

当前平台为 `linux/amd64`。工作流先构建两个镜像并加载到 runner，再检查健康接口、Web 页面、容器创建、SSH 终端和免密 sudo，通过后才登录 GHCR 并发布。发布基础镜像后再发布服务端，避免服务端先出现而基础镜像尚未推送。

## 首次配置

1. 将工作流及相关部署文件推送到仓库默认分支，确认仓库允许 GitHub Actions 运行。
2. 在 Actions 页面选择 **Publish Docker images → Run workflow** 进行试跑。
3. 工作流使用内置 `GITHUB_TOKEN`，权限为 `contents: read` 和 `packages: write`；不需要添加 PAT 或 Docker Hub Secret。若账号策略禁止写入 Packages，需要允许此工作流的包写入权限。
4. 第一次推送成功后，在 GitHub 账号的 Packages 中分别打开 `session-box` 和 `session-box-base`，进入 **Package settings → Change visibility → Public**。源码仓库公开不会自动使新 Package 公开。

镜像包含 `org.opencontainers.image.source` 标签以关联源码仓库。Fork 的工作流使用 fork 自己的 owner/repository 命名；`compose.release.yml` 中的镜像地址则固定指向本项目。

## 标签与正式发布

- 发布 GitHub Release（`published` 事件）触发版本镜像构建。只推送 Git tag 不触发发布。
- Release 标签格式为 `vMAJOR.MINOR.PATCH`，如 `v0.1.0`；对应镜像标签为 `0.1.0`。
- 预发布可用 `v0.2.0-rc.1`，对应 `0.2.0-rc.1`；预发布字符使用小写，不支持 `+build` 元数据。
- 非预发布且没有预发布后缀的版本同时更新两个镜像的 `latest`。重新发布旧正式版本同样会更新 `latest`，因此不要用此方式维护旧版本。
- 手动运行只发布 `sha-<完整提交 SHA>`，不更新 `latest`。可以设置 `SESSIONBOX_VERSION=sha-...` 部署试跑镜像。

第一次正式发布：在 Releases 页面创建例如 `v0.1.0` 的 Release，选定包含工作流的提交并发布，等待 Actions 成功。若试跑尚未将 Package 设为 Public，完成后再设置两个 Package 的可见性。

## 验证与升级

首次发布后，在 Linux Docker 主机执行：

```bash
docker pull ghcr.io/herrionic/session-box:0.1.0
docker pull ghcr.io/herrionic/session-box-base:0.1.0
SESSIONBOX_VERSION=0.1.0 docker compose -f compose.release.yml up -d
curl -f http://127.0.0.1:8787/api/health
```

将示例版本替换为实际发布版本。通过 Web 创建管理员和一个容器，确认文件浏览与终端工作。发布工作流中的 Docker/SSH 检查只有在 Actions 实际运行成功后才算验证完成。

`compose.release.yml` 是独立文件，不需要与源码或开发 Compose 合并。使用同一个目录和 Compose 项目名时，沿用现有数据卷；升级前备份数据卷中的数据库与 `master.key`。服务端升级不会重建已有 Agent 容器。

建议在 `.env` 固定 `SESSIONBOX_VERSION`，升级时修改版本，再运行 `pull` 和 `up -d`。使用 `latest` 时还需手动拉取基础镜像：服务端的按需拉取仅在本地没有镜像时进行。

## 官方参考

- [GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GHCR 认证、仓库关联和公开可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
