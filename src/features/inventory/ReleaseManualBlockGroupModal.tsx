import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Unlock } from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ManualBlockGroup, ManualBlockGroupMutationReceipt } from "../../api/types";
import { useSession } from "../../app/session";
import { ErrorState, Modal, ModalActions } from "../../components/ui/primitives";
import { releaseManualBlockGroup } from "./inventoryApi";
import { manualBlockGroupMutationRecoveryAction } from "./manualBlockGroupWorkflow";
import { resolveManualBlockGroupReleaseAttempt, type ManualBlockMutationAttempt } from "./manualBlockMutationAttempt";

export function ReleaseManualBlockGroupModal({
  group,
  propertyId,
  attemptRef,
  authorityCurrent,
  onCompleted,
  onRefreshRequired,
  onClose,
}: {
  group: ManualBlockGroup;
  propertyId: string;
  attemptRef: MutableRefObject<ManualBlockMutationAttempt | null>;
  authorityCurrent: boolean;
  onCompleted: (receipt: ManualBlockGroupMutationReceipt) => void;
  onRefreshRequired: () => void;
  onClose: () => void;
}) {
  const { request } = useSession();
  const authority = useRef(authorityCurrent);
  authority.current = authorityCurrent;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [receipt, setReceipt] = useState<ManualBlockGroupMutationReceipt | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      if (!mounted.current || !authority.current || group.propertyId !== propertyId) throw new Error("Refresh current access and Inventory evidence before releasing this exact group.");
      attemptRef.current = resolveManualBlockGroupReleaseAttempt(
        attemptRef.current,
        propertyId,
        group.blockGroupId,
        group.version,
      );
      return releaseManualBlockGroup(request, propertyId, group.blockGroupId, {
        operationId: attemptRef.current.operationId,
        expectedVersion: group.version,
        confirmed: true,
      });
    },
    onSuccess: (nextReceipt) => {
      if (!mounted.current) return;
      attemptRef.current = null;
      setReceipt(nextReceipt);
      onCompleted(nextReceipt);
    },
  });
  const recovery = mutation.error ? manualBlockGroupMutationRecoveryAction(mutation.error) : null;

  return (
    <Modal
      open
      title={receipt ? "Inventory released" : "Release this block group?"}
      description={receipt
        ? "The confirmed operation has a durable, recoverable receipt."
        : "Review the current group version before restoring its active inventory to sale."}
      onClose={() => { if (!mutation.isPending) onClose(); }}
    >
      {receipt ? (
        <div className="space-y-5" aria-live="polite">
          <div className="flex gap-3 rounded-lg border border-success/25 bg-success/10 p-4">
            <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={20} />
            <div>
              <p className="font-semibold">Release completed</p>
              <p className="mt-1 text-sm text-base-content/60">
                {receipt.releasedNowBlockCount ?? receipt.releasedBlockCount ?? receipt.affectedBlockCount} inventory {receipt.affectedBlockCount === 1 ? "unit was" : "units were"} released by this operation.
              </p>
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <ReceiptValue label="Released now" value={String(receipt.releasedNowBlockCount ?? receipt.releasedBlockCount ?? 0)} />
            <ReceiptValue label="Already released" value={String(receipt.alreadyReleasedBlockCount ?? 0)} />
            <ReceiptValue label="Active now" value={String(receipt.activeBlockCount ?? 0)} />
          </dl>
          <ModalActions>
            <button type="button" className="btn btn-primary btn-sm sm:btn-md" onClick={onClose}>Done</button>
          </ModalActions>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex gap-3 rounded-lg border border-warning/25 bg-warning/10 p-4 text-sm">
            <AlertTriangle className="mt-0.5 shrink-0 text-warning-content" size={19} />
            <div>
              <p className="font-semibold">{group.activeBlockCount} active {group.activeBlockCount === 1 ? "unit" : "units"} will be released atomically</p>
              <p className="mt-1 leading-6 text-base-content/60">New availability checks can use those units again. Historical group, member, actor, and receipt records remain available.</p>
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <ReceiptValue label="Stay range" value={`${formatDate(group.arrival)} – ${formatDate(group.departure)}`} />
            <ReceiptValue label="Current version" value={String(group.version)} />
          </dl>
          <div className="rounded-lg bg-base-200 p-4 text-sm">
            <p className="font-semibold">Reason</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-base-content/65">{group.reason || "No reason recorded"}</p>
          </div>
          {mutation.error && <ErrorState error={mutation.error} title="Couldn't release the block group" />}
          <ModalActions>
            <button type="button" className="btn btn-ghost btn-sm sm:btn-md" onClick={onClose} disabled={mutation.isPending}>Cancel</button>
            {recovery === "refresh" ? (
              <button type="button" className="btn btn-primary btn-sm sm:btn-md" onClick={() => { onRefreshRequired(); onClose(); }}>Close and refresh the group</button>
            ) : (
              <button type="button" className="btn btn-error btn-sm min-w-36 text-white sm:btn-md" onClick={() => { if (recovery === "restart") attemptRef.current = null; mutation.mutate(); }} disabled={mutation.isPending || !authorityCurrent}>
                {mutation.isPending ? <span className="loading loading-spinner loading-sm" /> : <Unlock size={17} />}
                {recovery === "restart" ? "Start new release attempt" : mutation.error ? "Retry release" : "Confirm release"}
              </button>
            )}
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

function ReceiptValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-base-200 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">{label}</dt><dd className="mt-1 break-words text-sm font-semibold">{value}</dd></div>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}
