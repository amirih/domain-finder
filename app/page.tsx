"use client";

import { useMemo, useRef, useState } from "react";
import { Button } from "primereact/button";
import { Column } from "primereact/column";
import { DataTable } from "primereact/datatable";
import { InputNumber } from "primereact/inputnumber";
import { InputText } from "primereact/inputtext";
import { InputSwitch } from "primereact/inputswitch";
import { Message } from "primereact/message";
import { ProgressBar } from "primereact/progressbar";
import { SelectButton } from "primereact/selectbutton";
import { Tag } from "primereact/tag";
import { Toolbar } from "primereact/toolbar";
import {
  estimateCandidateUpperBound,
  generateCandidates,
  MAX_CANDIDATES,
  MAX_DOMAIN_CHECKS,
  normalizeExtensions,
  parseSeedAndExtension,
  patternLiteralLength,
} from "@/lib/combinations";
import type { CheckResult, DomainRow, DomainStatus } from "@/types/domain";

const CHECK_BATCH_SIZE = 25;

type StatusFilter = "all" | "available" | "registered" | "unknown";

type SortOrder = 1 | -1 | 0;

const statusOptions: { label: string; value: StatusFilter }[] = [
  { label: "All", value: "all" },
  { label: "Available", value: "available" },
  { label: "Registered", value: "registered" },
  { label: "Unknown", value: "unknown" },
];

function statusSeverity(
  status: DomainStatus,
): "success" | "danger" | "warning" | "info" | "secondary" {
  switch (status) {
    case "available":
      return "success";
    case "registered":
      return "danger";
    case "unknown":
      return "warning";
    case "checking":
      return "info";
    default:
      return "secondary";
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(rows: DomainRow[], filename: string) {
  const headers = [
    "candidate",
    "domain",
    "extension",
    "status",
    "checked_at",
    "detail",
    "icann_lookup",
    "rdap_url",
  ];
  const lines = rows.map((row) =>
    [
      row.name,
      row.domain,
      row.extension,
      row.status,
      row.checkedAt,
      row.detail,
      row.lookupUrl,
      row.rdapUrl,
    ]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob([[headers.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function HomePage() {
  const [rawInput, setRawInput] = useState("");
  const [seed, setSeed] = useState("");
  const [extensionInput, setExtensionInput] = useState(".com");
  const [length, setLength] = useState<number>(4);
  const [includeNumbers, setIncludeNumbers] = useState(false);
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [selectedRows, setSelectedRows] = useState<DomainRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>(1);
  const [isChecking, setIsChecking] = useState(false);
  const [checkedCount, setCheckedCount] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stopRef = useRef(false);

  const requiredLength = useMemo(() => patternLiteralLength(seed), [seed]);
  const upperBound = useMemo(
    () => estimateCandidateUpperBound(seed, length, includeNumbers),
    [seed, length, includeNumbers],
  );
  const extensions = useMemo(
    () => normalizeExtensions(extensionInput),
    [extensionInput],
  );
  const domainUpperBound = upperBound * extensions.length;

  const counts = useMemo(() => {
    const result = {
      available: 0,
      registered: 0,
      unknown: 0,
      pending: 0,
      checking: 0,
    };
    for (const row of rows) result[row.status]++;
    return result;
  }, [rows]);

  const viewRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const statusMatches =
        statusFilter === "all" || row.status === statusFilter;
      if (!statusMatches) return false;
      if (!needle) return true;
      return [
        row.name,
        row.domain,
        row.extension,
        row.status,
        row.detail ?? "",
      ].some((value) => value.toLowerCase().includes(needle));
    });

    if (!sortField || sortOrder === 0) return filtered;
    return [...filtered].sort((a, b) => {
      const left = String(a[sortField as keyof DomainRow] ?? "").toLowerCase();
      const right = String(b[sortField as keyof DomainRow] ?? "").toLowerCase();
      return left.localeCompare(right) * sortOrder;
    });
  }, [rows, query, statusFilter, sortField, sortOrder]);

  const progress = rows.length
    ? Math.round((checkedCount / rows.length) * 100)
    : 0;

  function onInputChange(value: string) {
    stopChecking();
    const previousParsed = parseSeedAndExtension(rawInput);
    const parsed = parseSeedAndExtension(value);
    setRawInput(value);
    setSeed(parsed.seed);

    if (parsed.extension) {
      setExtensionInput(parsed.extension);
    } else if (!rawInput.trim() || previousParsed.extension) {
      setExtensionInput(".com");
    }

    const parsedRequiredLength = patternLiteralLength(parsed.seed);
    if (parsed.seed && length < Math.max(parsedRequiredLength, 1))
      setLength(Math.max(parsedRequiredLength, 1));
    
  
  }

  function onExtensionChange(value: string) {
    setExtensionInput(value);
  }

  function patchBatch(start: number, patcher: (row: DomainRow) => DomainRow) {
    setRows((current) => {
      const next = [...current];
      const end = Math.min(start + CHECK_BATCH_SIZE, next.length);
      for (let index = start; index < end; index++)
        next[index] = patcher(next[index]);
      return next;
    });
  }

  async function checkRows(generatedRows: DomainRow[]) {
    setIsChecking(true);
    setCheckedCount(0);
    stopRef.current = false;

    for (
      let start = 0;
      start < generatedRows.length;
      start += CHECK_BATCH_SIZE
    ) {
      if (stopRef.current) break;
      const batch = generatedRows.slice(start, start + CHECK_BATCH_SIZE);
      patchBatch(start, (row) => ({
        ...row,
        status: "checking",
        detail: "Checking registry RDAP…",
      }));

      try {
        const response = await fetch("/api/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: batch.map((row) => row.domain) }),
        });
        const payload = (await response.json()) as {
          results?: CheckResult[];
          error?: string;
        };
        if (!response.ok || !payload.results)
          throw new Error(payload.error ?? `HTTP ${response.status}`);

        const byDomain = new Map(
          payload.results.map((result) => [result.domain, result]),
        );
        patchBatch(start, (row) => {
          const result = byDomain.get(row.domain);
          return result
            ? { ...row, ...result }
            : {
                ...row,
                status: "unknown",
                detail: "No result returned by the domain check.",
              };
        });
      } catch (batchError) {
        const detail =
          batchError instanceof Error
            ? batchError.message
            : "Domain check failed.";
        patchBatch(start, (row) => ({ ...row, status: "unknown", detail }));
      }

      setCheckedCount(Math.min(start + batch.length, generatedRows.length));
    }

    setIsChecking(false);
    if (stopRef.current)
      setNotice("Checking stopped. Unchecked rows remain pending.");
  }

  async function generateAndCheck() {
    setError("");
    setNotice("");
    setSelectedRows([]);
    setStatusFilter("all");
    setQuery("");

    try {
      const candidates = generateCandidates(seed, length, includeNumbers);
      const normalizedExtensions = normalizeExtensions(extensionInput);
      const totalDomains = candidates.length * normalizedExtensions.length;

      if (totalDomains > MAX_DOMAIN_CHECKS) {
        throw new Error(
          `${candidates.length.toLocaleString()} candidates × ${normalizedExtensions.length.toLocaleString()} extensions = ${totalDomains.toLocaleString()} domains. The app safety limit is ${MAX_DOMAIN_CHECKS.toLocaleString()} domain checks. Reduce the length or number of extensions.`,
        );
      }

      setExtensionInput(normalizedExtensions.join(", "));
      const generatedRows: DomainRow[] = candidates.flatMap((name) =>
        normalizedExtensions.map((normalizedExtension) => ({
          id: `${name}${normalizedExtension}`,
          name,
          domain: `${name}${normalizedExtension}`,
          extension: normalizedExtension,
          status: "pending" as const,
        })),
      );
      setRows(generatedRows);
      setNotice(
        `Generated ${candidates.length.toLocaleString()} unique combinations across ${normalizedExtensions.length.toLocaleString()} extension${normalizedExtensions.length === 1 ? "" : "s"} = ${generatedRows.length.toLocaleString()} domains. Registration checks started.`,
      );
      await checkRows(generatedRows);
    } catch (generationError) {
      setRows([]);
      setCheckedCount(0);
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Unable to generate combinations.",
      );
    }
  }

  function stopChecking() {
    stopRef.current = true;
  }

  function selectView() {
    setSelectedRows(viewRows);
  }

  function selectAvailable() {
    setSelectedRows(rows.filter((row) => row.status === "available"));
  }

  const statusBody = (row: DomainRow) => (
    <Tag
      value={row.status[0].toUpperCase() + row.status.slice(1)}
      severity={statusSeverity(row.status)}
      rounded
    />
  );

  const registrationBody = (row: DomainRow) => {
    if (row.status === "registered") {
      return (
        <div className="link-stack">
          {row.lookupUrl && (
            <a href={row.lookupUrl} target="_blank" rel="noreferrer">
              ICANN lookup <i className="pi pi-external-link" />
            </a>
          )}
          {row.rdapUrl && (
            <a
              href={row.rdapUrl}
              target="_blank"
              rel="noreferrer"
              className="secondary-link"
            >
              Registry RDAP
            </a>
          )}
        </div>
      );
    }
    if (row.status === "unknown" && row.lookupUrl) {
      return (
        <a href={row.lookupUrl} target="_blank" rel="noreferrer">
          Check ICANN <i className="pi pi-external-link" />
        </a>
      );
    }
    return (
      <span className="muted">
        {row.status === "available" ? "No registration record" : "Not checked"}
      </span>
    );
  };

  const toolbarStart = (
    <div className="toolbar-group">
      <SelectButton
        value={statusFilter}
        onChange={(event) =>
          setStatusFilter((event.value ?? "all") as StatusFilter)
        }
        options={statusOptions}
        optionLabel="label"
        optionValue="value"
        allowEmpty={false}
      />
      <span className="p-input-icon-left search-box">
        <i className="pi pi-search" style={{ paddingLeft: "0.3rem" }} />

        <InputText
          value={query}
          style={{ paddingLeft: "1.5rem" }}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search results"
        />
      </span>
    </div>
  );

  const toolbarEnd = (
    <div className="toolbar-group export-buttons">
      <Button
        label="Select view"
        icon="pi pi-check-square"
        severity="secondary"
        outlined
        onClick={selectView}
        disabled={!viewRows.length}
      />
      <Button
        label="Select available"
        icon="pi pi-check-circle"
        severity="secondary"
        outlined
        onClick={selectAvailable}
        disabled={!counts.available}
      />
      <Button
        label="Export view"
        icon="pi pi-download"
        outlined
        onClick={() => downloadCsv(viewRows, "domain-view.csv")}
        disabled={!viewRows.length}
      />
      <Button
        label="Export all"
        icon="pi pi-database"
        onClick={() => downloadCsv(rows, "domain-all.csv")}
        disabled={!rows.length}
      />
    </div>
  );

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <span className="eyebrow">
            <i className="pi pi-globe" /> Domain Combination Finder
          </span>
          <h1>Generate every domain combination around your pattern.</h1>
          <p>
            Use letters plus <strong>*</strong> wildcards, choose an exact name
            length, and generate every unique combination. Extra characters can
            appear before, after, and at every wildcard. Then check each domain
            through the TLD&apos;s authoritative RDAP service.
          </p>
        </div>
      </section>

      <section className="generator-card">
        <div className="field-grid">
          <label className="field-block">
            <span>Word or domain</span>
            <InputText
              value={rawInput}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  generateAndCheck();
                }
              }}
              placeholder="domain, do*main, or do*ma*in.com"
              autoComplete="off"
            />
            <small>
              * matches zero or more generated characters. Example: do*main or
              do*ma*in.com.
            </small>
              <div className="character-option">
              <InputSwitch
                inputId="include-numbers"
                checked={includeNumbers}
                onChange={(event) => setIncludeNumbers(Boolean(event.value))}
              />
              <label htmlFor="include-numbers">
                <strong>Include numbers 0-9</strong>
                <small>
                  {includeNumbers
                    ? "Wildcards and free positions use a-z and 0-9."
                    : "Wildcards and free positions use a-z only."}
                </small>
              </label>
            </div>
          </label>

          <label className="field-block">
            <span>Exact name length</span>
            <InputNumber
              value={length}
              onValueChange={(event) =>
                setLength(event.value ?? Math.max(requiredLength, 1))
              }
              min={Math.max(requiredLength, 1)}
              max={63}
              showButtons
              useGrouping={false}
            />
            <small>
              The extension is not included in this length. * does not count as
              a fixed character.
            </small>
          
          </label>

          <label className="field-block">
            <span>Domain extensions</span>
            <InputText
              value={extensionInput}
              onChange={(event) => onExtensionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  generateAndCheck();
                }
              }}
              placeholder=".com, .org, .net"
            />
            <div className="extension-tags">
              {extensions.map((item) => (
                <Tag key={item} value={item} severity="info" rounded />
              ))}
            </div>
            <small>
              Separate multiple extensions with commas, spaces, or semicolons.
              Defaults to .com.
            </small>
          </label>
        </div>

        <div className="estimate-row">
          <div>
            <span className="estimate-label">Domain upper bound</span>
            <strong>{domainUpperBound.toLocaleString()}</strong>
            <small>
              Up to {upperBound.toLocaleString()} generated names ×{" "}
              {extensions.length.toLocaleString()} extension
              {extensions.length === 1 ? "" : "s"}. Duplicate names from
              overlapping wildcard placements are removed.
            </small>
          </div>
          <div className="action-row">
            {isChecking ? (
              <Button
                label="Stop checking"
                icon="pi pi-stop-circle"
                severity="danger"
                outlined
                onClick={stopChecking}
              />
            ) : (
              <Button
                label="Generate & check all"
                icon="pi pi-bolt"
                onClick={generateAndCheck}
                disabled={
                  !seed ||
                  length < Math.max(requiredLength, 1) ||
                  upperBound === 0 ||
                  domainUpperBound > MAX_DOMAIN_CHECKS
                }
              />
            )}
          </div>
        </div>

        {upperBound > MAX_CANDIDATES && (
          <Message
            severity="warn"
            text={`Large request: the app allows at most ${MAX_CANDIDATES.toLocaleString()} unique generated candidates. Reduce length${includeNumbers ? " or disable numbers" : ""}.`}
          />
        )}
        {domainUpperBound > MAX_DOMAIN_CHECKS && (
          <Message
            severity="warn"
            text={`Too many domain checks: up to ${domainUpperBound.toLocaleString()} domains across ${extensions.length.toLocaleString()} extensions. The limit is ${MAX_DOMAIN_CHECKS.toLocaleString()}.`}
          />
        )}
        {error && <Message severity="error" text={error} />}
        {notice && <Message severity="info" text={notice} />}
      </section>

      {rows.length > 0 && (
        <section className="results-card">
          <div className="results-heading">
            <div>
              <span className="eyebrow">Results</span>
              <h2>{rows.length.toLocaleString()} domains</h2>
            </div>
            <div className="stat-chips">
              <Tag
                value={`${counts.available.toLocaleString()} available`}
                severity="success"
                rounded
              />
              <Tag
                value={`${counts.registered.toLocaleString()} registered`}
                severity="danger"
                rounded
              />
              <Tag
                value={`${counts.unknown.toLocaleString()} unknown`}
                severity="warning"
                rounded
              />
              <Tag
                value={`${selectedRows.length.toLocaleString()} selected`}
                severity="info"
                rounded
              />
            </div>
          </div>

          {(isChecking || checkedCount > 0) && (
            <div className="progress-wrap">
              <div className="progress-label">
                <span>
                  {isChecking
                    ? "Checking registration data…"
                    : "Registration check progress"}
                </span>
                <strong>
                  {checkedCount.toLocaleString()} /{" "}
                  {rows.length.toLocaleString()}
                </strong>
              </div>
              <ProgressBar value={progress} showValue={false} />
            </div>
          )}

          <Toolbar
            start={toolbarStart}
            end={toolbarEnd}
            className="results-toolbar"
          />

          <DataTable
            value={viewRows}
            dataKey="id"
            selectionMode="checkbox"
            selection={selectedRows}
            onSelectionChange={(event) => setSelectedRows(event.value)}
            paginator
            rows={25}
            rowsPerPageOptions={[25, 50, 100]}
            paginatorTemplate="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown CurrentPageReport"
            currentPageReportTemplate="{first}-{last} of {totalRecords}"
            removableSort
            sortField={sortField}
            sortOrder={sortOrder}
            onSort={(event) => {
              setSortField(event.sortField ?? "name");
              setSortOrder((event.sortOrder ?? 0) as SortOrder);
            }}
            emptyMessage="No rows match the current filters."
            stripedRows
            size="small"
            scrollable
            scrollHeight="6400px"
            className="domain-table"
          >
            <Column selectionMode="multiple" headerStyle={{ width: "3rem" }} />
            <Column
              field="name"
              header="Candidate"
              sortable
              frozen
              style={{ minWidth: "12rem" }}
            />
            <Column
              field="domain"
              header="Domain"
              sortable
              style={{ minWidth: "15rem" }}
            />
            <Column
              field="extension"
              header="TLD"
              sortable
              style={{ minWidth: "7rem" }}
            />
            <Column
              field="status"
              header="Status"
              sortable
              body={statusBody}
              style={{ minWidth: "9rem" }}
            />
            <Column
              header="Registration data"
              body={registrationBody}
              style={{ minWidth: "11rem" }}
            />
            <Column
              field="detail"
              header="Details"
              sortable
              style={{ minWidth: "24rem" }}
            />
          </DataTable>

          <p className="disclaimer">
            “Available” means the authoritative RDAP service returned no
            registration record. It does not guarantee that a registrar will
            sell the domain; names can still be reserved, blocked,
            premium-priced, or otherwise unavailable for purchase.
          </p>
        </section>

        
      )}
      <section className="footer">
            &copy; {new Date().getFullYear()} Hossein Amiri
            <br />
            GitHub: <a href="https://github.com/onapplications/domain-finder" target="_blank" rel="noopener noreferrer">
              https://github.com/onapplications/domain-finder
            </a>
      </section>
    </main>
  );
}
