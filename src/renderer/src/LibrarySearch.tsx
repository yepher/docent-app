import { useState } from "react";
import type { Citation, DocSet } from "../../shared/types";
export function LibrarySearch({
  sets,
  onCite,
}: {
  sets: DocSet[];
  onCite: (c: Citation) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Citation[]>([]);
  const [status, setStatus] = useState(
    "Search filenames, headings, or words in your documents. No model needed.",
  );
  const [scope, setScope] = useState("all");
  const [filter, setFilter] = useState("");
  const [after, setAfter] = useState("");
  const search = async () => {
    setStatus("Searching…");
    try {
      const found = await window.api.library.search({
        query,
        setIds: scope === "all" ? [] : [Number(scope)],
      });
      setResults(found);
      setStatus(
        `${found.length} matching passages${found.length === 40 ? " (first 40)" : ""}`,
      );
    } catch (e) {
      setStatus(String(e));
    }
  };
  return (
    <section className="library-search">
      <h2>Search your library</h2>
      <p className="fine">
        Search works offline, even while models are stopped.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="search-form"
      >
        <input
          aria-label="Search library"
          placeholder="Filename, phrase, or keyword"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Search set"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="all">All sets</option>
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button disabled={!query.trim()}>Search</button>
      </form>
      <div className="actions">
        <input
          aria-label="Filter filenames"
          placeholder="Filter filenames"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label>
          Indexed since{" "}
          <input
            type="date"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </label>
      </div>
      <p role="status" className="fine">
        {status}
      </p>
      {results
        .filter(
          (c) =>
            c.title.toLowerCase().includes(filter.toLowerCase()) &&
            (!after || (c.indexedAt ?? 0) >= new Date(after).getTime()),
        )
        .map((c, i) => (
          <button className="search-result" key={i} onClick={() => onCite(c)}>
            <strong>{c.title}</strong>
            <small>
              {c.setName} · {c.page ? `Page ${c.page}` : `Line ${c.line ?? 1}`}
              {c.warning ? " · Needs attention" : ""}
            </small>
            <span>{c.excerpt}</span>
          </button>
        ))}
    </section>
  );
}
