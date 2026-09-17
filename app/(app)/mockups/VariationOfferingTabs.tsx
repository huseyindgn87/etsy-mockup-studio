"use client";

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ListingFormValue } from "./ListingForm";
import type { CombinationModel } from "@/lib/etsy/variation-combinations";
import {
  FIELD_NOUN,
  TAB_FIELD,
  applyNumericBulk,
  applyProcessingBulk,
  filterRows,
  generateSkus,
  individualIndices,
  offeringRows,
  photoPropertyIndex,
  setCell,
  setIndividual,
  setPhotoProperty,
  type BulkOperation,
  type BulkResult,
  type FieldTab,
  type OfferingError,
  type OfferingRow,
  type ProcessingProfile,
} from "@/lib/etsy/variation-offerings";

export interface VariationPhotoOption {
  slotId: string;
  thumbnailUrl: string | null;
  label: string;
}

export interface OfferingJump {
  key: string | null;
  nonce: number;
}

interface PanelProps {
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  /** Applies `partial` only once the user confirms `message`. */
  confirm: (message: string, partial: Partial<ListingFormValue>) => void;
  model: CombinationModel;
  /** This tab's errors — empty unless errors are being shown. */
  errors: OfferingError[];
  jump: OfferingJump | null;
}

export const ROW_HEIGHT = 44;
const PHOTO_ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 440;
const OVERSCAN = 5;

const inputCls =
  "h-8 w-full rounded-md border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-red-500 dark:border-white/15 dark:bg-zinc-950";
const buttonCls =
  "h-8 shrink-0 rounded-md border border-black/10 px-3 text-sm font-medium hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]";

const PRICE_TYPING_RE = /^\d*(\.\d{0,2})?$/;
const QUANTITY_TYPING_RE = /^\d*$/;

/** A function whose identity never changes but that always runs the latest `fn` — keeps memoized rows from re-rendering. */
function useStableHandler<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  const [stable] = useState(() => (...args: A) => ref.current(...args));
  return stable;
}

function currencySymbol(code: string | null): string | null {
  if (!code) return null;
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? code
    );
  } catch {
    return code;
  }
}

/**
 * A fixed-row-height list that renders only the rows in (or near) view, so a
 * 450-combination grid mounts a couple of dozen rows. `scrollTo` scrolls a
 * row into view whenever a new object is passed.
 */
function VirtualRows({
  count,
  rowHeight = ROW_HEIGHT,
  scrollTo,
  renderRow,
}: {
  count: number;
  rowHeight?: number;
  scrollTo: { index: number } | null;
  renderRow: (index: number, style: CSSProperties) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const targetTop = (s: { index: number } | null) => (s && s.index >= 0 ? Math.max(0, (s.index - 1) * rowHeight) : 0);
  const [scrollTop, setScrollTop] = useState(() => targetTop(scrollTo));
  const [seen, setSeen] = useState(scrollTo);
  if (scrollTo !== seen) {
    setSeen(scrollTo);
    if (scrollTo && scrollTo.index >= 0) setScrollTop(targetTop(scrollTo));
  }
  const top = Math.min(scrollTop, Math.max(0, count * rowHeight - VIEWPORT_HEIGHT));

  useEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  }, [top]);

  const start = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((top + VIEWPORT_HEIGHT) / rowHeight) + OVERSCAN);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(renderRow(i, { position: "absolute", top: i * rowHeight, left: 0, right: 0, height: rowHeight }));
  }

  return (
    <div
      ref={ref}
      role="rowgroup"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ maxHeight: VIEWPORT_HEIGHT }}
      className="overflow-y-auto"
    >
      <div style={{ position: "relative", height: count * rowHeight }}>{rows}</div>
    </div>
  );
}

function gridColumns(labelCount: number, trailing: string) {
  return { gridTemplateColumns: `repeat(${labelCount}, minmax(0, 1fr)) ${trailing}` };
}

function TableHeader({ names, last, trailing }: { names: string[]; last: string; trailing: string }) {
  return (
    <div
      role="row"
      aria-rowindex={1}
      style={gridColumns(names.length, trailing)}
      className="grid items-center gap-3 border-b border-black/10 px-2 py-1.5 text-xs font-medium text-zinc-500 dark:border-white/15"
    >
      {names.map((n, i) => (
        <span key={i} role="columnheader" className="truncate">
          {n}
        </span>
      ))}
      <span role="columnheader">{last}</span>
    </div>
  );
}

function RowFilter({ query, onQuery, shown, total }: { query: string; onQuery: (q: string) => void; shown: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="search"
        aria-label="Filter combinations"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Filter by option, e.g. Black"
        className={`${inputCls} max-w-xs`}
      />
      <span className="text-xs text-zinc-500">
        {shown === total ? `${total} ${total === 1 ? "row" : "rows"}` : `${shown} of ${total} rows`}
      </span>
    </div>
  );
}

function EmptyGrid({ model, variationCount }: { model: CombinationModel; variationCount: number }) {
  const message =
    variationCount === 0 ? "Add a variation on the Variations tab first."
    : model.tooMany ? "There are too many combinations to edit — remove some options on the Variations tab."
    : "Add at least one option to every variation on the Variations tab first.";
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-black/20 py-10 text-center dark:border-white/25">
      <p className="text-sm text-zinc-500">{message}</p>
    </div>
  );
}

type CellKind = "price" | "quantity" | "sku" | "readiness";

interface CellInputProps {
  kind: CellKind;
  cellKey: string | null;
  label: string;
  text: string;
  placeholder: string;
  error: string | undefined;
  errorId: string;
  symbol: string | null;
  profiles: readonly ProcessingProfile[] | null;
  onCell: (key: string | null, text: string) => void;
}

function CellInput({ kind, cellKey, label, text, placeholder, error, errorId, symbol, profiles, onCell }: CellInputProps) {
  const common = {
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
  } as const;
  if (kind === "readiness") {
    return (
      <select {...common} value={text} onChange={(e) => onCell(cellKey, e.target.value)} className={inputCls}>
        <option value="">{placeholder ? "Same as listing" : "Choose a profile"}</option>
        {(profiles ?? []).map((p) => (
          <option key={p.readinessStateId} value={p.readinessStateId}>
            {p.displayLabel}
          </option>
        ))}
        {text && profiles && !profiles.some((p) => String(p.readinessStateId) === text) && (
          <option value={text}>Profile #{text}</option>
        )}
      </select>
    );
  }
  if (kind === "sku") {
    return (
      <input
        {...common}
        type="text"
        value={text}
        maxLength={500}
        placeholder={placeholder}
        onChange={(e) => onCell(cellKey, e.target.value)}
        className={inputCls}
      />
    );
  }
  const typing = kind === "price" ? PRICE_TYPING_RE : QUANTITY_TYPING_RE;
  return (
    <div className="relative">
      {kind === "price" && symbol && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-zinc-500">
          {symbol}
        </span>
      )}
      <input
        {...common}
        type="text"
        inputMode={kind === "price" ? "decimal" : "numeric"}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          // Only digits (and, for price, two decimals) get in — so never a negative.
          if (typing.test(e.target.value)) onCell(cellKey, e.target.value);
        }}
        onBlur={() => {
          if (kind === "price" && text !== "" && text !== "." && Number(text).toFixed(2) !== text) {
            onCell(cellKey, Number(text).toFixed(2));
          }
        }}
        className={`${inputCls} ${kind === "price" && symbol ? (symbol.length > 1 ? "pl-10" : "pl-6") : ""}`}
      />
    </div>
  );
}

interface FieldRowProps extends Omit<CellInputProps, "label" | "errorId" | "cellKey"> {
  rowKey: string;
  labels: readonly string[];
  hidden: boolean;
  rowIndex: number;
  noun: string;
  style: CSSProperties;
  columns: CSSProperties;
}

const FieldRow = memo(function FieldRow({ rowKey, labels, hidden, rowIndex, noun, style, columns, ...cell }: FieldRowProps) {
  const errorId = useId();
  const name = labels.join(" / ");
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      data-row-key={rowKey}
      data-error={cell.error ? "true" : undefined}
      style={{ ...style, ...columns }}
      className={`grid items-center gap-3 border-b border-black/5 px-2 dark:border-white/10 ${
        cell.error ? "bg-red-50 dark:bg-red-950/20" : ""
      } ${hidden ? "text-zinc-400 dark:text-zinc-500" : ""}`}
    >
      {labels.map((l, i) => (
        <span key={i} role="cell" className="truncate text-sm">
          {l}
          {hidden && i === labels.length - 1 && <span className="ml-1.5 text-xs">(hidden)</span>}
        </span>
      ))}
      <div role="cell" className={`flex min-w-0 items-center gap-2 ${hidden ? "opacity-60" : ""}`}>
        <div className="w-40 shrink-0">
          <CellInput {...cell} cellKey={rowKey} label={`${noun} for ${name}`} errorId={errorId} />
        </div>
        {cell.error && (
          <span id={errorId} title={cell.error} className="truncate text-xs text-red-600">
            {cell.error}
          </span>
        )}
      </div>
    </div>
  );
});

type ProcessingOperation = "set" | "increase" | "decrease";

function BulkBar({
  tab,
  profiles,
  onApply,
}: {
  tab: "price" | "quantity" | "processing";
  profiles: readonly ProcessingProfile[] | null;
  onApply: (operation: BulkOperation, amount: string) => void;
}) {
  const [operation, setOperation] = useState<BulkOperation>("set");
  const [amount, setAmount] = useState("");
  const operations: { value: BulkOperation; label: string }[] = [
    { value: "set", label: "Set to" },
    { value: "increase", label: tab === "processing" ? "Increase days by" : "Increase by" },
    { value: "decrease", label: tab === "processing" ? "Decrease days by" : "Decrease by" },
    ...(tab === "price"
      ? ([
          { value: "increasePercent", label: "Increase by %" },
          { value: "decreasePercent", label: "Decrease by %" },
        ] as const)
      : []),
  ];
  const chooseProfile = tab === "processing" && operation === "set";
  return (
    <div role="group" aria-label={`Bulk edit ${FIELD_NOUN[TAB_FIELD[tab]].one}`} className="flex flex-wrap items-center gap-1.5">
      <select
        aria-label="Bulk operation"
        value={operation}
        onChange={(e) => {
          setOperation(e.target.value as BulkOperation);
          setAmount("");
        }}
        className={`${inputCls} w-auto`}
      >
        {operations.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {chooseProfile ? (
        <select aria-label="Bulk amount" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputCls} w-44`}>
          <option value="">Choose a profile</option>
          {(profiles ?? []).map((p) => (
            <option key={p.readinessStateId} value={p.readinessStateId}>
              {p.displayLabel}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          aria-label="Bulk amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            const typing = tab === "price" && !operation.endsWith("Percent") ? PRICE_TYPING_RE : operation.endsWith("Percent") ? /^\d*(\.\d*)?$/ : QUANTITY_TYPING_RE;
            if (typing.test(e.target.value)) setAmount(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onApply(operation, amount);
            }
          }}
          placeholder={operation.endsWith("Percent") ? "%" : tab === "processing" ? "days" : "0"}
          className={`${inputCls} w-24`}
        />
      )}
      <button type="button" onClick={() => onApply(operation, amount)} disabled={!amount} className={buttonCls}>
        Apply
      </button>
    </div>
  );
}

function SkuGenerator({ onGenerate }: { onGenerate: (template: string, start: number) => void }) {
  const [template, setTemplate] = useState("");
  const [start, setStart] = useState("1");
  return (
    <div className="space-y-1 rounded-lg border border-black/10 p-2 dark:border-white/15">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          aria-label="SKU pattern"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder="TEE-{Size}-{Primary color}-{###}"
          className={`${inputCls} min-w-56 flex-1`}
        />
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          Counter starts at
          <input
            type="text"
            inputMode="numeric"
            aria-label="Counter start"
            value={start}
            onChange={(e) => {
              if (QUANTITY_TYPING_RE.test(e.target.value)) setStart(e.target.value);
            }}
            className={`${inputCls} w-16`}
          />
        </label>
        <button
          type="button"
          onClick={() => onGenerate(template, Number(start || "0"))}
          disabled={!template.trim()}
          className={buttonCls}
        >
          Generate SKUs
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        {"{Size}"} or {"{1}"} inserts that variation&apos;s option; {"{#}"} a counter, {"{###}"} zero-padded (001). Fills
        every row shown.
      </p>
    </div>
  );
}

/** Price, Quantity, SKU or Processing: "Individual" toggles, a bulk bar, and a row per value combination. */
export function FieldTabPanel({
  tab,
  value,
  patch,
  confirm,
  model,
  errors,
  jump,
  currencyCode,
  profiles,
}: PanelProps & { tab: FieldTab; currencyCode: string | null; profiles: readonly ProcessingProfile[] | null }) {
  const field = TAB_FIELD[tab];
  const noun = FIELD_NOUN[field];
  const Noun = noun.one[0].toUpperCase() + noun.one.slice(1);
  const variations = value.variations;
  const indicesKey = individualIndices(value, field).join(",");
  const indices = useMemo(() => (indicesKey ? indicesKey.split(",").map(Number) : []), [indicesKey]);
  const rows = useMemo(() => offeringRows(model, indices), [model, indices]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [seenJump, setSeenJump] = useState(jump);
  if (jump !== seenJump) {
    setSeenJump(jump);
    if (jump) setQuery("");
  }
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const scrollTo = useMemo(
    () => (jump && jump.key != null ? { index: shown.findIndex((r) => r.key === jump.key) } : null),
    // Only a new jump scrolls; filtering alone doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jump],
  );
  const errorByKey = useMemo(() => new Map(errors.map((e) => [e.key ?? "", e.message])), [errors]);
  const hiddenKeys = useMemo(() => {
    const hidden = new Set<string>();
    for (const r of rows) if (r.combinationKeys.every((k) => value.variationRowEnabled[k] === false)) hidden.add(r.key);
    return hidden;
  }, [rows, value.variationRowEnabled]);

  const onCell = useStableHandler((key: string | null, text: string) => patch(setCell(value, field, key, text)));

  const symbol = useMemo(() => currencySymbol(currencyCode), [currencyCode]);
  const base = field === "readiness" ? (value.readinessStateId == null ? "" : String(value.readinessStateId)) : value[field];
  const kind: CellKind = field;
  const columns = useMemo(() => gridColumns(indices.length, "minmax(10rem, 1.4fr)"), [indices.length]);
  const listingWideErrorId = useId();

  if (variations.length === 0 || model.combinations.length === 0) {
    return <EmptyGrid model={model} variationCount={variations.length} />;
  }

  function toggle(index: number, on: boolean) {
    setMessage(null);
    const change = setIndividual(value, field, index, on);
    if (change.discarded > 0) {
      const n = change.discarded;
      confirm(
        `Turning off individual ${noun.one} for “${variations[index].name || `variation ${index + 1}`}” keeps one ${noun.one} per merged row and discards ${n} different ${n === 1 ? noun.one : noun.many}.`,
        change.patch,
      );
    } else {
      patch(change.patch);
    }
  }

  function applyBulk(operation: BulkOperation, amount: string) {
    const keys = indices.length > 0 ? shown.map((r) => r.key) : null;
    const result: BulkResult =
      tab === "processing"
        ? applyProcessingBulk(value, keys, operation as ProcessingOperation, amount, profiles ?? [])
        : applyNumericBulk(value, tab as "price" | "quantity", keys, operation, amount);
    if (!result.ok) {
      setMessage({ error: true, text: result.error });
      return;
    }
    patch(result.patch);
    const total = keys ? keys.length : 1;
    const skipped =
      result.skipped > 0
        ? ` ${result.skipped} ${result.skipped === 1 ? "row was" : "rows were"} left unchanged (${
            tab === "processing" ? "no matching profile" : `no ${noun.one} to change`
          }).`
        : "";
    setMessage({ error: false, text: `Applied to ${total - result.skipped} of ${total} ${total === 1 ? "row" : "rows"}.${skipped}` });
  }

  function generate(template: string, start: number) {
    const result = generateSkus(template, shown, variations, indices, start);
    if (!result.ok) {
      setMessage({ error: true, text: result.error });
      return;
    }
    patch({ variationRows: { ...value.variationRows, sku: { ...value.variationRows.sku, ...result.cells } } });
    const n = Object.keys(result.cells).length;
    setMessage({ error: false, text: `Filled ${n} ${n === 1 ? "SKU" : "SKUs"}.` });
  }

  const listingWideError = errorByKey.get("");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {variations.map((v, i) => (
            <label key={i} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={indices.includes(i)} onChange={(e) => toggle(i, e.target.checked)} />
              Individual {noun.one}{" "}
              <span className="text-zinc-500">({v.name || `Variation ${i + 1}`})</span>
            </label>
          ))}
        </div>
        {tab !== "sku" && <BulkBar tab={tab} profiles={profiles} onApply={applyBulk} />}
      </div>

      {message && (
        <p role={message.error ? "alert" : "status"} className={`text-xs ${message.error ? "text-red-600" : "text-zinc-500"}`}>
          {message.text}
        </p>
      )}

      {indices.length === 0 ? (
        <div className="max-w-sm space-y-1">
          <p className="text-xs text-zinc-500">
            One {noun.one} for every combination. Check “Individual {noun.one}” to set it per option.
          </p>
          <CellInput
            kind={kind}
            cellKey={null}
            label={`${Noun} for every combination`}
            text={base}
            placeholder={tab === "sku" ? "optional" : ""}
            error={listingWideError}
            errorId={listingWideErrorId}
            symbol={symbol}
            profiles={profiles}
            onCell={onCell}
          />
          {listingWideError && (
            <p id={listingWideErrorId} className="text-xs text-red-600">
              {listingWideError}
            </p>
          )}
          {tab === "processing" && (
            <p className="text-xs text-zinc-500">This is the processing profile chosen in the Shipping section.</p>
          )}
        </div>
      ) : (
        <>
          {tab === "sku" && <SkuGenerator onGenerate={generate} />}
          <RowFilter query={query} onQuery={setQuery} shown={shown.length} total={rows.length} />
          <div role="table" aria-label={`${Noun} per combination`} aria-rowcount={shown.length + 1} className="rounded-lg border border-black/10 dark:border-white/15">
            <TableHeader names={indices.map((i) => variations[i].name || `Variation ${i + 1}`)} last={Noun} trailing="minmax(10rem, 1.4fr)" />
            <VirtualRows
              count={shown.length}
              scrollTo={scrollTo}
              renderRow={(i, style) => {
                const row = shown[i];
                return (
                  <FieldRow
                    key={row.key}
                    rowKey={row.key}
                    labels={row.labels}
                    hidden={hiddenKeys.has(row.key)}
                    rowIndex={i}
                    noun={Noun}
                    style={style}
                    columns={columns}
                    kind={kind}
                    text={value.variationRows[field][row.key] ?? ""}
                    placeholder={base}
                    error={errorByKey.get(row.key)}
                    symbol={symbol}
                    profiles={profiles}
                    onCell={onCell}
                  />
                );
              }}
            />
          </div>
          {tab !== "sku" && field !== "readiness" && base && (
            <p className="text-xs text-zinc-500">A blank row uses the listing&apos;s {noun.one} ({base}).</p>
          )}
        </>
      )}
    </div>
  );
}

const VisibilityRow = memo(function VisibilityRow({
  row,
  visible,
  rowIndex,
  style,
  columns,
  onToggle,
}: {
  row: OfferingRow;
  visible: boolean;
  rowIndex: number;
  style: CSSProperties;
  columns: CSSProperties;
  onToggle: (key: string, visible: boolean) => void;
}) {
  const name = row.labels.join(" / ");
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      data-row-key={row.key}
      style={{ ...style, ...columns }}
      className={`grid items-center gap-3 border-b border-black/5 px-2 dark:border-white/10 ${
        visible ? "" : "bg-black/[.03] text-zinc-400 dark:bg-white/[.04] dark:text-zinc-500"
      }`}
    >
      {row.labels.map((l, i) => (
        <span key={i} role="cell" className="truncate text-sm">
          {l}
        </span>
      ))}
      <div role="cell" className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={visible}
          aria-label={`Offer ${name}`}
          onClick={() => onToggle(row.key, !visible)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${visible ? "bg-primary" : "bg-zinc-300 dark:bg-zinc-700"}`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${visible ? "left-[1.125rem]" : "left-0.5"}`}
          />
        </button>
        <span className="text-xs">{visible ? "Offered" : "Hidden"}</span>
      </div>
    </div>
  );
});

/** One row per full combination with an "offered" switch. Hidden combinations keep all their data. */
export function VisibilityPanel({ value, patch, model }: PanelProps) {
  const variations = value.variations;
  const all = useMemo(() => variations.map((_, i) => i), [variations]);
  const rows = useMemo(() => offeringRows(model, all), [model, all]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const onToggle = useStableHandler((key: string, visible: boolean) => {
    const next = { ...value.variationRowEnabled };
    if (visible) delete next[key];
    else next[key] = false;
    patch({ variationRowEnabled: next });
  });
  const columns = useMemo(() => gridColumns(all.length, "minmax(8rem, 1fr)"), [all.length]);

  if (variations.length === 0 || model.combinations.length === 0) {
    return <EmptyGrid model={model} variationCount={variations.length} />;
  }
  const hiddenCount = rows.filter((r) => value.variationRowEnabled[r.key] === false).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        A hidden combination isn&apos;t offered to buyers but keeps its price, quantity and SKU.
        {hiddenCount > 0 && ` ${hiddenCount} of ${rows.length} hidden.`}
      </p>
      <RowFilter query={query} onQuery={setQuery} shown={shown.length} total={rows.length} />
      <div role="table" aria-label="Visibility per combination" aria-rowcount={shown.length + 1} className="rounded-lg border border-black/10 dark:border-white/15">
        <TableHeader names={variations.map((v, i) => v.name || `Variation ${i + 1}`)} last="Visibility" trailing="minmax(8rem, 1fr)" />
        <VirtualRows
          count={shown.length}
          scrollTo={null}
          renderRow={(i, style) => (
            <VisibilityRow
              key={shown[i].key}
              row={shown[i]}
              visible={value.variationRowEnabled[shown[i].key] !== false}
              rowIndex={i}
              style={style}
              columns={columns}
              onToggle={onToggle}
            />
          )}
        />
      </div>
    </div>
  );
}

/** Etsy assigns photos on one variation only: pick it, then a photo per option. */
export function PhotosPanel({
  value,
  patch,
  confirm,
  model,
  errors,
  jump,
  photoSlots,
}: PanelProps & { photoSlots: readonly VariationPhotoOption[] }) {
  const variations = value.variations;
  const photoIndex = photoPropertyIndex(variations);
  const photoVariation = photoIndex == null ? null : variations[photoIndex];
  const errorByKey = useMemo(() => new Map(errors.map((e) => [e.key ?? "", e.message])), [errors]);
  const scrollTo = useMemo(
    () => (jump && jump.key != null && photoVariation ? { index: photoVariation.valueIds.map(String).indexOf(jump.key) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jump],
  );

  if (variations.length === 0 || model.combinations.length === 0) {
    return <EmptyGrid model={model} variationCount={variations.length} />;
  }

  function choose(index: number | null) {
    const change = setPhotoProperty(value, index);
    if (change.discarded > 0) {
      const n = change.discarded;
      confirm(`Changing the variation photos are assigned on discards ${n} photo ${n === 1 ? "assignment" : "assignments"}.`, change.patch);
    } else {
      patch(change.patch);
    }
  }

  function assign(valueId: number, slotId: string | null) {
    const next = { ...value.variationPhotos };
    if (slotId == null) delete next[String(valueId)];
    else next[String(valueId)] = slotId;
    patch({ variationPhotos: next });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Photos vary by
          <select
            aria-label="Photos vary by"
            value={photoIndex == null ? "" : String(photoIndex)}
            onChange={(e) => choose(e.target.value === "" ? null : Number(e.target.value))}
            className={`${inputCls} w-auto`}
          >
            <option value="">No variation</option>
            {variations.map((v, i) => (
              <option key={i} value={i}>
                {v.name || `Variation ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-zinc-500">Etsy lets buyers see a photo per option on one variation only.</p>
      </div>

      {photoVariation == null ? null : photoSlots.length === 0 ? (
        <p className="text-sm text-zinc-500">Add photos in the Photos section first.</p>
      ) : (
        <div role="table" aria-label={`Photo per ${photoVariation.name || "option"}`} aria-rowcount={photoVariation.valueIds.length + 1} className="rounded-lg border border-black/10 dark:border-white/15">
          <TableHeader names={[photoVariation.name || `Variation ${photoIndex! + 1}`]} last="Photo" trailing="minmax(0, 4fr)" />
          <VirtualRows
            count={photoVariation.valueIds.length}
            rowHeight={PHOTO_ROW_HEIGHT}
            scrollTo={scrollTo}
            renderRow={(i, style) => {
              const valueId = photoVariation.valueIds[i];
              const name = photoVariation.values[i];
              const chosen = value.variationPhotos[String(valueId)] ?? null;
              const error = errorByKey.get(String(valueId));
              const combos = model.combinations.filter((c) => c.valueIds[photoIndex!] === valueId);
              const hidden = combos.length > 0 && combos.every((c) => value.variationRowEnabled[c.key] === false);
              return (
                <div
                  key={valueId}
                  role="row"
                  aria-rowindex={i + 2}
                  data-row-key={String(valueId)}
                  data-error={error ? "true" : undefined}
                  style={{ ...style, ...gridColumns(1, "minmax(0, 4fr)") }}
                  className={`grid items-center gap-3 border-b border-black/5 px-2 dark:border-white/10 ${
                    error ? "bg-red-50 dark:bg-red-950/20" : ""
                  } ${hidden ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                >
                  <span role="cell" className="min-w-0 text-sm">
                    <span className="block truncate">
                      {name}
                      {hidden && <span className="ml-1.5 text-xs">(hidden)</span>}
                    </span>
                    {error && <span className="block truncate text-xs text-red-600">{error}</span>}
                  </span>
                  <div role="cell" className={`flex min-w-0 gap-1.5 overflow-x-auto py-1 ${hidden ? "opacity-60" : ""}`}>
                    <button
                      type="button"
                      aria-pressed={chosen == null}
                      aria-label={`No photo for ${name}`}
                      onClick={() => assign(valueId, null)}
                      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-md border text-[10px] text-zinc-500 ${
                        chosen == null ? "border-primary ring-2 ring-primary/40" : "border-black/10 dark:border-white/15"
                      }`}
                    >
                      None
                    </button>
                    {photoSlots.map((slot, n) => (
                      <button
                        key={slot.slotId}
                        type="button"
                        aria-pressed={chosen === slot.slotId}
                        aria-label={`Photo ${n + 1} for ${name}`}
                        title={slot.label}
                        onClick={() => assign(valueId, slot.slotId)}
                        className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-md border ${
                          chosen === slot.slotId ? "border-primary ring-2 ring-primary/40" : "border-black/10 dark:border-white/15"
                        }`}
                      >
                        {slot.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={slot.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-xs text-zinc-500">{n + 1}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
