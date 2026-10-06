import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import type { FileEntry } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { describeError } from "../lib/errors.ts";
import { Alert, Button } from "./ui.tsx";

const WORKSPACE = "/workspace";

export function FileBrowser({ containerId }: { containerId: string }): JSX.Element {
  const { t } = useI18n();
  const [path, setPath] = useState(WORKSPACE);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState<{
    path: string;
    content: string;
    original: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (target: string): Promise<void> => {
      setBusy(true);
      try {
        const response = await api.listFiles(containerId, target);
        setEntries(sortEntries(response.entries));
        setPath(response.path);
        setError(null);
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [containerId],
  );

  useEffect(() => {
    void load(WORKSPACE);
  }, [load]);

  const navigate = (target: string): void => {
    setOpenFile(null);
    void load(target);
  };

  const create = async (type: "file" | "directory"): Promise<void> => {
    const name = window.prompt(
      type === "file" ? t("files.newFileName") : t("files.newFolderName"),
    );
    if (name === null || name.trim() === "") return;
    setError(null);
    try {
      await api.createFile(containerId, joinPath(path, name.trim()), type);
      await load(path);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const removeEntry = async (entry: FileEntry): Promise<void> => {
    if (!window.confirm(t("files.deleteConfirm", { path: entry.path }))) return;
    setError(null);
    try {
      await api.removeFile(containerId, entry.path, entry.type === "directory");
      if (openFile?.path === entry.path) setOpenFile(null);
      await load(path);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const openEditor = async (entry: FileEntry): Promise<void> => {
    setError(null);
    try {
      const file = await api.readFile(containerId, entry.path);
      setOpenFile({ path: file.path, content: file.content, original: file.content });
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const save = async (): Promise<void> => {
    if (openFile === null) return;
    setSaving(true);
    setError(null);
    try {
      const file = await api.writeFile(containerId, openFile.path, openFile.content);
      setOpenFile({ path: file.path, content: file.content, original: file.content });
      await load(path);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setError(null);
    try {
      await api.uploadFile(containerId, joinPath(path, file.name), file);
      await load(path);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const segments = path.split("/").filter((segment) => segment !== "");

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              className="text-slate-400 transition hover:text-slate-200"
              onClick={() => navigate("/")}
            >
              /
            </button>
            {segments.map((segment, index) => {
              const target = `/${segments.slice(0, index + 1).join("/")}`;
              return (
                <span key={target} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="text-slate-400 transition hover:text-slate-200"
                    onClick={() => navigate(target)}
                  >
                    {segment}
                  </button>
                  {index < segments.length - 1 ? <span className="text-slate-600">/</span> : null}
                </span>
              );
            })}
          </nav>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void create("file")}>
              {t("files.newFile")}
            </Button>
            <Button variant="secondary" onClick={() => void create("directory")}>
              {t("files.newFolder")}
            </Button>
            <Button variant="secondary" onClick={() => uploadRef.current?.click()}>
              {t("common.upload")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void load(path)}>
              {t("common.refresh")}
            </Button>
            <input ref={uploadRef} type="file" hidden onChange={(event) => void onUpload(event)} />
          </div>
        </div>

        {error !== null && (
          <div className="mb-3">
            <Alert>{error}</Alert>
          </div>
        )}

        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">{t("files.empty")}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-4 font-medium">{t("common.name")}</th>
                <th className="py-2 pr-4 font-medium">{t("files.colSize")}</th>
                <th className="py-2 pr-4 font-medium">{t("files.colModified")}</th>
                <th className="py-2 text-right font-medium">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-2 pr-4">
                    <span className="mr-2">{entry.type === "directory" ? "📁" : "📄"}</span>
                    <button
                      type="button"
                      className="text-slate-200 transition hover:text-indigo-300"
                      onClick={() =>
                        entry.type === "directory" ? navigate(entry.path) : void openEditor(entry)
                      }
                    >
                      {entry.name}
                    </button>
                  </td>
                  <td className="py-2 pr-4 text-slate-400">
                    {entry.type === "directory" ? "—" : formatSize(entry.size)}
                  </td>
                  <td className="py-2 pr-4 text-slate-400">
                    {new Date(entry.modifiedAt).toLocaleString(
                      document.documentElement.lang || undefined,
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-2">
                      {entry.type === "file" ? (
                        <a
                          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-slate-700"
                          href={api.downloadUrl(containerId, entry.path)}
                        >
                          {t("common.download")}
                        </a>
                      ) : null}
                      <Button variant="danger" onClick={() => void removeEntry(entry)}>
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {openFile !== null && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-sm text-slate-300">{openFile.path}</h2>
            <div className="flex gap-2">
              <Button
                disabled={saving || openFile.content === openFile.original}
                onClick={() => void save()}
              >
                {saving ? t("common.saving") : t("common.save")}
              </Button>
              <a
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-slate-700"
                href={api.downloadUrl(containerId, openFile.path)}
              >
                {t("common.download")}
              </a>
              <Button variant="secondary" onClick={() => setOpenFile(null)}>
                {t("common.close")}
              </Button>
            </div>
          </div>

          <textarea
            className="h-80 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-sm text-slate-100 outline-none transition focus:border-indigo-500"
            value={openFile.content}
            spellCheck={false}
            onChange={(event) =>
              setOpenFile((current) =>
                current === null ? current : { ...current, content: event.target.value },
              )
            }
          />
        </section>
      )}
    </div>
  );
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type === "directory" && right.type !== "directory") return -1;
    if (left.type !== "directory" && right.type === "directory") return 1;
    return left.name.localeCompare(right.name);
  });
}

function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
