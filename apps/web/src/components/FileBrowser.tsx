import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import type { FileEntry } from "@sessionbox/protocol";
import { api } from "../api.ts";
import { describeError } from "./ContainerList.tsx";

const WORKSPACE = "/workspace";

export function FileBrowser({ containerId }: { containerId: string }): JSX.Element {
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
    const name = window.prompt(type === "file" ? "New file name" : "New folder name");
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
    if (!window.confirm(`Delete ${entry.path}?`)) return;
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
    <>
      <section className="card">
        <div className="file-toolbar">
          <nav className="breadcrumbs">
            <button type="button" className="link-button" onClick={() => navigate("/")}>
              /
            </button>
            {segments.map((segment, index) => {
              const target = `/${segments.slice(0, index + 1).join("/")}`;
              return (
                <span key={target}>
                  <button type="button" className="link-button" onClick={() => navigate(target)}>
                    {segment}
                  </button>
                  {index < segments.length - 1 ? <span className="crumb-sep">/</span> : null}
                </span>
              );
            })}
          </nav>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void create("file")}>
              New file
            </button>
            <button type="button" className="secondary" onClick={() => void create("directory")}>
              New folder
            </button>
            <button type="button" className="secondary" onClick={() => uploadRef.current?.click()}>
              Upload
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void load(path)}>
              Refresh
            </button>
            <input ref={uploadRef} type="file" hidden onChange={(event) => void onUpload(event)} />
          </div>
        </div>

        {error !== null && (
          <div className="alert" role="alert">
            {error}
            <button type="button" className="link" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {entries.length === 0 ? (
          <p className="empty">This directory is empty.</p>
        ) : (
          <table className="container-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th className="actions-header">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <span className="file-icon">{entry.type === "directory" ? "📁" : "📄"}</span>
                    {entry.type === "directory" ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => navigate(entry.path)}
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void openEditor(entry)}
                      >
                        {entry.name}
                      </button>
                    )}
                  </td>
                  <td>{entry.type === "directory" ? "—" : formatSize(entry.size)}</td>
                  <td>{new Date(entry.modifiedAt).toLocaleString()}</td>
                  <td className="actions">
                    {entry.type === "file" ? (
                      <a className="button-link" href={api.downloadUrl(containerId, entry.path)}>
                        Download
                      </a>
                    ) : null}
                    <button type="button" className="danger" onClick={() => void removeEntry(entry)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {openFile !== null ? (
        <section className="card">
          <div className="file-toolbar">
            <h2 className="mono">{openFile.path}</h2>
            <div className="actions">
              <button
                type="button"
                disabled={saving || openFile.content === openFile.original}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <a className="button-link" href={api.downloadUrl(containerId, openFile.path)}>
                Download
              </a>
              <button type="button" className="secondary" onClick={() => setOpenFile(null)}>
                Close
              </button>
            </div>
          </div>
          <textarea
            className="editor"
            value={openFile.content}
            spellCheck={false}
            onChange={(event) =>
              setOpenFile((current) =>
                current === null ? current : { ...current, content: event.target.value },
              )
            }
          />
        </section>
      ) : null}
    </>
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
