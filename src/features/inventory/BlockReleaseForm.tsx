import type { FormEvent } from "react";
import { isInsufficientAuthenticationError } from "../../app/authenticationAssurance";
import { ErrorState, FormActions } from "../../components/ui/primitives";
import { RecentAuthenticationPrompt } from "../../components/ui/RecentAuthenticationPrompt";
import { BlockEditorFrame } from "./BlockEditorFrame";
import type { useManualBlockEditor } from "./useManualBlockEditor";

export function BlockReleaseForm({ editor }: { editor: ReturnType<typeof useManualBlockEditor> }) {
  if (editor.editor?.kind !== "release") return null;
  const { target } = editor.editor;
  const mutation = editor.releaseMutation;
  const retryAvailable = editor.releaseCanSubmit;
  const needsAuthentication = retryAvailable && isInsufficientAuthenticationError(mutation.error);
  const feedback = mutation.error && !retryAvailable ? "release-needs-review" : mutation.error;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editor.releaseCanSubmit && !mutation.isPending && !mutation.error) editor.release();
  }
  return <BlockEditorFrame inline title={`Release ${target.label}?`} onClose={editor.close} opener={editor.opener} feedback={feedback}>
    <p className="text-sm">{target.detail}</p>
    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="font-semibold">Dates</dt>{target.intervals.map((interval) => <dd key={`${interval.arrival}:${interval.departure}`} className="mt-1">{formatDate(interval.arrival)} until {formatDate(interval.departure)}</dd>)}</div>
      <div><dt className="font-semibold">Reason</dt>{target.reasons.map((reason) => <dd key={reason} className="mt-1 break-words">{reason}</dd>)}</div>
    </dl>
    <p className="mt-3 text-sm">This removes the hold from {target.unitCount} {target.unitCount === 1 ? "unit" : "units"}. Inventory may become available for reservations if otherwise eligible.</p>
    {editor.mayManageGroups && editor.releaseGroup.isFetching && <p role="status" className="mt-3 text-sm">Checking the current block-group version…</p>}
    {editor.releaseGroup?.error && <div className="mt-3"><ErrorState error={editor.releaseGroup.error} title="Couldn't confirm the block-group version" retry={() => void editor.releaseGroup.refetch()} /></div>}
    {!editor.releaseCanSubmit && !mutation.isPending && <div role="status" data-feedback-focus className="mt-3 border-l-2 border-warning px-3 py-2 text-sm">
      <p>{editor.releaseTargetCurrent ? "Current access and inventory are required. This exact confirmation is kept while information refreshes." : "This exact group changed, was released, or is no longer in the current view. Refresh or check All; cancel and review it again before acting."}</p>
      <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => void editor.refresh()}>Refresh blocks</button>
    </div>}
    {needsAuthentication ? <div className="mt-4 space-y-3"><RecentAuthenticationPrompt error={mutation.error} onAuthenticated={editor.retryRelease} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={editor.close}>Cancel</button></div> : <form onSubmit={submit} className="mt-4">
      {mutation.error && retryAvailable && <><ErrorState error={mutation.error} title="Couldn't release the block" retry={editor.retryRelease} />
        <p className="mt-2 text-xs text-base-content/60">Try again repeats the same release. Check All if the outcome is uncertain.</p></>}
      <FormActions submitting={mutation.isPending} cancelDisabled={mutation.isPending} disabled={!editor.releaseCanSubmit || Boolean(mutation.error)} submitLabel="Confirm release" onCancel={editor.close} />
    </form>}
  </BlockEditorFrame>;
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
