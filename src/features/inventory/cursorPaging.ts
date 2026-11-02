export type CursorPageState = {
  page: number;
  cursor: string | null;
  previousCursors: Array<string | null>;
};

export function initialCursorPage(): CursorPageState {
  return { page: 1, cursor: null, previousCursors: [] };
}

export function nextCursorPage(state: CursorPageState, nextCursor: string | null): CursorPageState {
  if (!canAdvanceCursor(state, nextCursor)) return state;
  return {
    page: state.page + 1,
    cursor: nextCursor!,
    previousCursors: [...state.previousCursors, state.cursor],
  };
}

export function canAdvanceCursor(state: CursorPageState, nextCursor: string | null): boolean {
  return Boolean(
    nextCursor &&
    nextCursor !== state.cursor &&
    !state.previousCursors.includes(nextCursor),
  );
}

export function previousCursorPage(state: CursorPageState): CursorPageState {
  if (!state.previousCursors.length) return state;
  const previousCursors = state.previousCursors.slice(0, -1);
  return {
    page: Math.max(1, state.page - 1),
    cursor: state.previousCursors.at(-1) ?? null,
    previousCursors,
  };
}
