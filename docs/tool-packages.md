# Docent tool packages, API 1

Docent tools are self-contained JavaScript packages. Bundled, personal, and community tools use the same package format, document API, tests, and isolated runner. A tool can inspect selected documents and return structured results with passage evidence. It cannot change the library or access the network, filesystem, shell, Electron, Node globals, or environment variables.

## Use and share tools

Open **Tools** in the chat header. Bundled tools are enabled initially. Imported and updated community or personal tools start disabled; enable one to make it available to the agent or run it on the current document selection. **Test examples** uses synthetic documents supplied by the package, with no access to your library.

**Make a local copy** preserves attribution and the license. **Edit new version** suggests the next patch version. Use **Test draft**, **Review package**, and **Install disabled** to save a revision. Installation checks the package and runs its included tests. Passing a package's own tests does not establish the correctness of its methodology; review its code and examples too.

**Export package** writes only the manifest, JavaScript, and synthetic tests. It does not export library documents, answers, run inputs, or run history. If you manually put private content into a fixture or the code, that content is part of the package: choose shareable examples deliberately. Local changes never update a GitHub repository automatically. Contribute an exported package through the repository's normal fork and pull-request workflow.

**Run history** keeps the latest 100 library runs, including failures. Each records the tool version and SHA-256 package hash, input parameters, selected set/document IDs, library fingerprint, elapsed time, measured coverage, result, and supporting excerpts. Agent answers also retain the run record. Library backups include installed packages, versions, repositories, and run history. Exporting a conversation includes its tool records.

## GitHub collections

Use **Repositories → Add repository** with a public URL such as `https://github.com/owner/collection`. GitHub credentials and private repositories are not supported in this version. Discovery and explicit update checks use the network; installed tools and their tests work offline. There are no background repository update checks.

The repository must have a `docent-tools.json` file at its root:

```json
{
  "format": "docent-tool-collection",
  "formatVersion": 1,
  "name": "My shared tools",
  "tools": [{
    "id": "count-mentions",
    "name": "Count documents mentioning a phrase",
    "description": "Count selected documents containing a literal phrase.",
    "version": "1.0.0",
    "file": "tools/count-mentions.docent-tool.json",
    "sha256": "REPLACE_WITH_SHA256_OF_THE_EXACT_PACKAGE_FILE_BYTES"
  }]
}
```

Names, descriptions, IDs, and versions must match their packages. Package paths must be relative, without traversal, and end in `.docent-tool.json`. A collection may list up to 100 tools. Each catalog or package download is limited to 512 KB. Redirects are rejected. Catalog checksums cover the exact downloaded file bytes; installed-package and run hashes cover the validated package serialized with sorted object keys, so formatting changes do not create a new installed version.

Docent resolves the latest published release tag to a commit SHA, or resolves the default branch when no release exists. It then fetches the catalog and packages from that exact commit. Put the catalog and package files in the release's source commit, not only in release assets. A checksum verifies that package bytes match the catalog; it does not certify the author or code. Community packages are labeled as community packages even if their author field says “Docent.”

**Check updates** refreshes the catalog without changing installed code. Review a version's package alongside the installed package before installing. Changing content requires a new `major.minor.patch` version; reusing an installed version with different content is rejected. Old versions stay available for offline rollback. Updates and rollback disable the tool until you enable it again. Removing a repository leaves its installed tools usable offline.

This app repository contains a ready-to-publish starter collection. Run `npm run build:tools` to regenerate `docent-tools.json` and `tool-packages/*.docent-tool.json` from `src/main/tools/bundled.ts`. Commit these generated files when releasing the collection. The command does not upload anything or create a GitHub release. Maintainers can fork this layout for their own collections.

New versions bundled with an app update appear under **Installed versions and rollback**. Your active version and enabled setting are retained until you choose another version.

To compute a package digest with Node:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' tools/example.docent-tool.json
```

## Package format

A `.docent-tool.json` file contains:

```json
{
  "format": "docent-tool",
  "formatVersion": 1,
  "manifest": {
    "id": "document-count",
    "name": "Count selected documents",
    "version": "1.0.0",
    "description": "Count documents in the current selection using library metadata.",
    "author": "Your name",
    "license": "MIT",
    "apiVersion": 1,
    "permissions": ["documents:read"],
    "inputSchema": {"type":"object", "properties":{}, "additionalProperties":false},
    "examples": [{"name":"Count documents", "input":{}}]
  },
  "code": "function run(input, library) { return { data: { documents: library.documents().total }, evidence: [] }; }",
  "tests": [{
    "name":"One synthetic document",
    "input":{},
    "documents":[{"title":"Example", "text":"Example text."}],
    "expectedData":{"documents":1}
  }]
}
```

- IDs use lowercase letters, digits, and hyphens; 2–64 characters, beginning with a letter. Origin namespaces keep community tools from replacing bundled tools.
- Version is `major.minor.patch` with numeric components. `apiVersion: 1` identifies compatibility with this document API.
- Include an author and license. Retain upstream attribution when adapting code.
- Only `documents:read` is supported. Other permissions and API versions are rejected.
- `code` is at most 128 KB and defines a synchronous `run(input, library)` function. Imports, installation hooks, runtime dependency downloads, and async entry points are unsupported. Include any necessary pure JavaScript helpers in this field.
- Provide 1–10 input examples and 1–10 tests. Tests may contain at most 10 synthetic documents each, up to 20,000 characters per document. Fixtures receive document IDs starting at 1, in order; passage IDs start at `p1`. `expectedData` is compared structurally with the returned `data`. Evidence IDs are independently validated.

### Input schema

Docent supports a bounded subset of JSON Schema: `type`, `description`, `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `minimum`, `maximum`, `maxLength`, and `maxItems`. Types are object, array, string, number, integer, and boolean. The root must be an object. Unknown fields and additional input properties are rejected. Schemas may be five levels deep with at most 20 fields per object.

Integer fields may use `format: "document-id"`; the app then offers a picker limited to the current document selection. Use `description` for a useful field label. Simple inputs get ordinary controls; structured inputs can be edited as JSON. All inputs are validated again before execution.

### Document API

All methods are synchronous from the script's perspective. Paging makes large collections available without passing the whole library into interpreter memory. A script only sees its captured set/document selection, regardless of arguments it supplies.

| Method | Result |
| --- | --- |
| `library.documents(offset = 0, limit = 200)` | `{total, nextOffset, documents: [{id, title, version, passageCount, warning}]}` |
| `library.read(documentId, offset = 0, limit = 50)` | `{total, nextOffset, passages: [{id, documentId, text, page, line}]}` |
| `library.search(query, limit = 20)` | `{passages: [...]}` from the offline keyword index; at most 50 passages |
| `library.references(documentId)` | `{entries: [{number, text, evidence: [passageId]}]}` for a recognized numbered bibliography |

Continue paging until `nextOffset` is `null`. An empty bibliography result means the extractor did not recognize a numbered bibliography; it does not establish that the document references no research. Bibliography extraction supports documents with at most 5,000 indexed passages.

Document text is untrusted data. Indexed passages overlap; counting phrase occurrences directly across them can double-count. The bundled phrase tool counts distinct documents. The duplicate tool compares saved original-content hashes, not semantic similarity. The comparison tool compares indexed passage text; edits can change chunk boundaries.

### Results and evidence

Return `{data: JSON, evidence: [passageId, ...]}`. The encoded result must be under 64 KB, with at most 100 evidence links. Use passage IDs returned by `read`, `search`, or `references`. Invented or out-of-scope IDs fail the run. Docent resolves evidence to saved excerpts and locations and assigns answer citation numbers separately from a paper's bibliography numbers.

Coverage is measured by the host, not supplied by the script. It distinguishes listed documents from read documents and passages, and reports unavailable or stale documents. A run that reads only matching search passages is incomplete for a collection-wide claim. If the selected library changes while a script is running, the result is rejected rather than mixing index versions.

## Execution limits and agent use

Every execution starts a fresh QuickJS WebAssembly interpreter inside a dedicated worker. The worker provides only the document API; package JavaScript is never evaluated in Node. The interpreter has a 32 MB heap and bounded stack. Library runs have a 30-second execution limit, tests have 5 seconds each, and the host can terminate a worker independently. At most two library runs and 50,000 API calls per run are allowed. **Stop tool** and chat cancellation terminate active work. Closing the tool panel cancels its active manual run.

Up to 12 tools can be enabled together. Enabled definitions are exposed to the local agent in document mode. Each question captures the enabled versions; changing a package mid-question cannot silently substitute a different version. Successful and failed tool executions appear with the answer. The model remains responsible for choosing an appropriate tool and interpreting its result; evidence links and coverage make that interpretation inspectable.

This first version supports user-authored and shared tools. It does not automatically author scripts, publish repositories, submit pull requests, install dependencies, or grant tools additional capabilities.
