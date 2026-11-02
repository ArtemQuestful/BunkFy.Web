import { BedDouble, Building2, DoorOpen, Layers3, MapPinned, Search } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import type { CompositeSource } from "../../app/compositeSourceState";
import { isInsufficientAuthenticationError } from "../../app/authenticationAssurance";
import { validStayDateRange, type StayDateRange } from "../../app/propertyDate";
import { CompositeSourceNotice } from "../../components/ui/CompositeSourceNotice";
import { ErrorState, FormActions } from "../../components/ui/primitives";
import { DatePicker } from "../../components/ui/DatePicker";
import { RecentAuthenticationPrompt } from "../../components/ui/RecentAuthenticationPrompt";
import { BlockEditorFrame } from "./BlockEditorFrame";
import { selectedBlockTargetCurrent } from "./blockEditorModel";
import type { BlockTargetKind, BlockTargetOption } from "./inventoryBlocking";
import type { useManualBlockEditor } from "./useManualBlockEditor";
import { presentManualBlockGroupPreview } from "./manualBlockGroupWorkflow";

const targetKinds = [
  { kind: "property", label: "Property", icon: MapPinned },
  { kind: "building", label: "Building", icon: Building2 },
  { kind: "floor", label: "Floor", icon: Layers3 },
  { kind: "room", label: "Room", icon: DoorOpen },
  { kind: "unit", label: "Bed / unit", icon: BedDouble },
] as const;

export function BlockInventoryModal({ editor, initialRange, initialTargetId, sources, inline = false }: {
  editor: ReturnType<typeof useManualBlockEditor>;
  initialRange: StayDateRange;
  initialTargetId?: string;
  sources: CompositeSource[];
  inline?: boolean;
}) {
  if (editor.editor?.kind !== "create") return null;
  return <BlockInventoryForm key={editor.editor.editorSession} editor={editor} initialRange={initialRange} initialTargetId={initialTargetId} sources={sources} inline={inline} />;
}

function BlockInventoryForm({ editor, initialRange, initialTargetId, sources, inline }: {
  editor: ReturnType<typeof useManualBlockEditor>;
  initialRange: StayDateRange;
  initialTargetId?: string;
  sources: CompositeSource[];
  inline: boolean;
}) {
  const { options, createMutation: mutation } = editor;
  const initialTarget = options.find((option) => option.id === initialTargetId) ?? null;
  const [contextualEntry] = useState(() => Boolean(initialTarget));
  const [choosingTarget, setChoosingTarget] = useState(() => !initialTarget);
  const targetChooserId = useId();
  const targetChooser = useRef<HTMLDivElement>(null);
  const targetSummary = useRef<HTMLHeadingElement>(null);
  const [targetKind, setTargetKind] = useState<BlockTargetKind>(() => initialTarget?.kind ?? (options.some((option) => option.kind === "room") ? "room" : options[0]?.kind ?? "room"));
  const [selected, setSelected] = useState<BlockTargetOption | null>(() => initialTarget);
  const [search, setSearch] = useState("");
  const [arrival, setArrival] = useState(initialRange.arrival);
  const [departure, setDeparture] = useState(initialRange.departure);
  const [reason, setReason] = useState("");
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const kindOptions = options.filter((option) => option.kind === targetKind);
  const visibleOptions = kindOptions.filter((option) => option.searchText.includes(search.trim().toLocaleLowerCase()));
  const selectedCurrent = selectedBlockTargetCurrent(options, selected);
  const currentSelected = selectedCurrent ? options.find((option) => option.id === selected?.id) : undefined;
  const selectedVisible = visibleOptions.some((option) => option.id === selected?.id);
  const rangeValid = validStayDateRange({ arrival, departure });
  const error = mutation.error ?? editor.previewMutation?.error;
  const needsAuthentication = isInsufficientAuthenticationError(error);
  // Refresh withholds submission, not the live controls or their popovers.
  const locked = editor.busy || Boolean(mutation.error);
  const canSubmit = editor.createCanSubmit(selected) && selectedVisible && rangeValid && !(!reason.trim() && reason.length > 0);
  const payload = selected ? { target: selected.target, arrival, departure, reason } : null;
  const previewCurrent = Boolean(editor.mayManageGroups && payload && editor.reviewMatches(payload, selected));
  const preview = previewCurrent && editor.createReview ? presentManualBlockGroupPreview(editor.createReview.preview) : null;

  function chooseKind(kind: BlockTargetKind) {
    setTargetKind(kind); setSearch("");
    setSelected(kind === "property" ? options.find((option) => option.kind === "property") ?? null : null);
  }
  function changeTarget() {
    setChoosingTarget(true);
    requestAnimationFrame(() => {
      const chooser = targetChooser.current;
      (chooser?.querySelector<HTMLElement>('input[type="search"]') ?? chooser?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
      const list = chooser?.querySelector<HTMLElement>('[role="radiogroup"]');
      const checked = list?.querySelector<HTMLInputElement>("input:checked")?.closest("label");
      if (list && checked) list.scrollTop += checked.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !selected || !reason.trim() || locked) return;
    if (editor.mayManageGroups && previewCurrent && preview?.canConfirm) editor.confirmCreate({ target: selected.target, arrival, departure, reason }, selected);
    else editor.create({ target: selected.target, arrival, departure, reason }, selected);
  }

  return <BlockEditorFrame inline={inline} title="Add block" description="Take a room, bed or area out of service."
    onClose={editor.close} opener={editor.opener} feedback={error ?? (previewCurrent ? editor.createReview : null)}>
    <CompositeSourceNotice className="mb-3" sources={sources} title="Block information is refreshing or unavailable" />
    {!editor.ready && !mutation.isPending && <p role="status" className="mb-3 text-sm text-warning-content">Your draft is kept. Current access, inventory and block records are required to submit.</p>}
    <form onSubmit={submit} className="space-y-4" hidden={needsAuthentication}>
      {selected && <div hidden={choosingTarget} className="border-l-2 border-base-300 pl-3" data-selected-block-target>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-base-content/60">{editor.ready && selectedCurrent ? "Selected target" : "Selection unconfirmed"} · {targetLabel(selected.kind)}</p>
            <h4 ref={targetSummary} tabIndex={-1} data-autofocus={contextualEntry || undefined}
              className="mt-1 break-words font-semibold outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">{currentSelected?.label ?? selected.label}</h4>
          </div>
          {!choosingTarget && <button type="button" className="btn btn-ghost btn-sm" disabled={locked}
            aria-expanded={choosingTarget} aria-controls={targetChooserId} onClick={changeTarget}>Change target</button>}
        </div>
        <p className="mt-1 break-words text-sm text-base-content/65">{currentSelected?.detail ?? selected.detail}</p>
        <p className="mt-1 text-xs text-base-content/65">{selected.unitIds.length} {selected.unitIds.length === 1 ? "unit" : "units"}{editor.mayManageGroups ? " in the local selection. Preview confirms the current server selection before you act." : editor.ready && selectedCurrent ? " will be blocked." : " in the last selected scope; confirm current records before submitting."}</p>
      </div>}
      <div ref={targetChooser} id={targetChooserId} hidden={!choosingTarget} className="space-y-4">
      <fieldset disabled={locked}>
        <legend className="mb-1.5 text-sm font-semibold">Scope</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-base-200 p-1 sm:grid-cols-5" aria-label="Inventory block scope">
          {targetKinds.filter(({ kind }) => kind === targetKind || options.some((option) => option.kind === kind)).map(({ kind, label, icon: Icon }) => (
            <button key={kind} type="button" className={`btn btn-sm w-full rounded-md border-0 ${targetKind === kind ? "bg-base-100 shadow-sm" : "btn-ghost"}`}
              aria-pressed={targetKind === kind} onClick={() => chooseKind(kind)}><Icon size={15} />{label}</button>
          ))}
        </div>
      </fieldset>
      {targetKind !== "property" && <label className="input input-bordered flex w-full items-center gap-2">
        <Search size={17} className="shrink-0 text-base-content/40" />
        <input type="search" className="min-w-0 grow" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${targetLabel(targetKind).toLocaleLowerCase()}`} aria-label={`Search ${targetLabel(targetKind).toLocaleLowerCase()}`} disabled={locked} />
      </label>}
      <div className="max-h-60 overflow-y-auto rounded-lg border border-base-300" role="radiogroup" aria-label={`${targetLabel(targetKind)} target`}>
        {!visibleOptions.length ? <p className="px-4 py-5 text-sm text-base-content/60">No matching inventory. Change the search or scope.</p> : visibleOptions.map((option) => (
          <label key={option.id} className={`flex items-center gap-3 border-b border-base-300 px-3 py-3 last:border-b-0 ${selectedCurrent && selected?.id === option.id ? "bg-primary/8" : "hover:bg-base-200/60"}`}>
            <input type="radio" name="blockTarget" value={option.id} checked={selectedCurrent && selected?.id === option.id} onChange={() => setSelected(option)} disabled={locked} className="radio radio-primary radio-sm shrink-0" />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{option.label}</span><span className="mt-0.5 block break-words text-xs text-base-content/60">{option.detail}</span></span>
            <span className="shrink-0 text-xs tabular-nums">{option.unitIds.length}</span>
          </label>
        ))}
      </div>
      <button type="button" className="btn btn-outline btn-sm" disabled={locked || !editor.ready || !selectedCurrent || !selectedVisible} onClick={() => {
        setChoosingTarget(false);
        requestAnimationFrame(() => targetSummary.current?.focus());
      }}>Use selected target</button>
      </div>
      {selected && !selectedCurrent && <div role="alert" className="border-l-2 border-warning px-3 py-2 text-sm">
        <p><strong>{selected.label}</strong> changed or is no longer eligible. Your draft is kept; review the current inventory and deliberately select a target again.</p>
        <button type="button" className="btn btn-ghost btn-sm mt-2" disabled={mutation.isPending} onClick={() => void editor.refresh()}>Refresh inventory</button>
      </div>}
      {selectedCurrent && selected && !selectedVisible && <p className="text-sm text-base-content/65">Clear the target search to review the selected space before submitting.</p>}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div><span className="mb-1.5 block text-sm font-semibold">From</span><DatePicker value={arrival} onChange={setArrival} ariaLabel="From" required disabled={locked} /></div>
        <div><span className="mb-1.5 block text-sm font-semibold">Until</span><DatePicker value={departure} onChange={setDeparture} ariaLabel="Until" min={arrival} required disabled={locked} />
          <p className="mt-1 text-xs text-base-content/60">Available again on this date, if otherwise eligible.</p></div>
      </div>
      {!rangeValid && <p role="alert" className="text-sm text-error">Choose valid dates. Until must be after From.</p>}
      <label className="block"><span className="mb-1.5 block text-sm font-semibold">Reason</span>
        <textarea ref={reasonInput} className="textarea textarea-bordered min-h-20 w-full" name="reason" value={reason} onChange={(event) => setReason(event.target.value)}
          placeholder="Maintenance, private use, deep clean…" required disabled={locked} />
      </label>
      {reason.length > 0 && !reason.trim() && <p role="alert" className="text-sm text-error">Enter a reason, not only spaces.</p>}
      {preview && <section role="status" data-block-preview className="rounded-lg border border-base-300 bg-base-200 p-4 text-sm">
        <h4 className="font-semibold">{preview.title}</h4><p className="mt-1">{preview.description}</p>
        <p className="mt-2 font-semibold">{preview.impactLabel}</p>
        {preview.canConfirm && <p className="mt-2">Confirm this exact target, dates, reason and server selection. Changes require another preview.</p>}
      </section>}
      {editor.previewMutation?.error && !mutation.error && !needsAuthentication && <ErrorState error={editor.previewMutation?.error} title="Couldn't preview the block" />}
      {mutation.error && !needsAuthentication && <><ErrorState error={mutation.error} title="Couldn't add the block" retry={canSubmit ? editor.retryCreate : undefined} />
        <p className="text-xs text-base-content/60">Try again repeats this exact attempt. Check refreshed records before starting a different block if the outcome is uncertain.</p>
        <button type="button" className="btn btn-ghost btn-sm" disabled={mutation.isPending} onClick={() => {
          editor.editCreateDraft();
          requestAnimationFrame(() => reasonInput.current?.focus());
        }}>Edit draft</button>
      </>}
      {!needsAuthentication && <FormActions submitting={editor.busy} cancelDisabled={editor.busy} disabled={!canSubmit || Boolean(mutation.error) || Boolean(preview && !preview.canConfirm)}
        submitLabel={editor.mayManageGroups ? preview?.canConfirm ? "Confirm block" : "Preview block" : selected && selected.unitIds.length > 1 ? `Block ${selected.unitIds.length} units` : "Add block"} onCancel={editor.close} />}
    </form>
    {needsAuthentication && <div className="space-y-3"><RecentAuthenticationPrompt error={error} onAuthenticated={() => {
      if (mutation.error) editor.retryCreate();
      else if (payload && selected) editor.create(payload, selected);
    }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={editor.close}>Cancel</button></div>}
  </BlockEditorFrame>;
}

function targetLabel(kind: BlockTargetKind) {
  return ({ property: "Property", building: "Building", floor: "Floor", room: "Room", unit: "Bed or unit" })[kind];
}
