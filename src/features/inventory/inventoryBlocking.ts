import type {
  InventoryBlockTarget,
  ManualBlock,
  RoomInventory,
} from "../../api/types";

export type BlockTargetKind = "property" | "building" | "floor" | "room" | "unit";

export type BlockTargetOption = {
  id: string;
  kind: BlockTargetKind;
  label: string;
  detail: string;
  target: InventoryBlockTarget;
  unitIds: string[];
  searchText: string;
};

export type ActiveBlockGroup = {
  blockGroupId: string;
  label: string;
  detail: string;
  arrival: string;
  departure: string;
  reason: string;
  blocks: ManualBlock[];
};

const targetKindValues = {
  property: 1,
  building: 2,
  floor: 3,
  room: 4,
  unit: 5,
} as const;

export function buildBlockTargetOptions(
  propertyName: string,
  rooms: RoomInventory[],
): BlockTargetOption[] {
  const sellableRooms = rooms
    .map((room) => ({
      room,
      units: room.units.filter((unit) => unit.isSellable && unit.isTopologyActive),
    }))
    .filter(({ units }) => units.length > 0);
  const allUnitIds = sellableRooms.flatMap(({ units }) => units.map((unit) => unit.inventoryUnitId));
  const options: BlockTargetOption[] = [];

  if (allUnitIds.length > 0) {
    options.push(createOption(
      "property",
      "property",
      propertyName,
      unitCountLabel(allUnitIds.length),
      target("property"),
      allUnitIds,
    ));
  }

  const buildings = groupBy(sellableRooms.filter(({ room }) => room.buildingLabel), ({ room }) => normalize(room.buildingLabel!));
  for (const group of buildings.values()) {
    const buildingLabel = group[0].room.buildingLabel!;
    const unitIds = group.flatMap(({ units }) => units.map((unit) => unit.inventoryUnitId));
    options.push(createOption(
      "building",
      `building:${normalize(buildingLabel)}`,
      physicalLabel("Building", buildingLabel),
      unitCountLabel(unitIds.length),
      target("building", { buildingLabel }),
      unitIds,
    ));
  }

  const floors = groupBy(
    sellableRooms.filter(({ room }) => room.floorLabel),
    ({ room }) => `${normalize(room.buildingLabel ?? "")}|${normalize(room.floorLabel!)}`,
  );
  for (const group of floors.values()) {
    const { buildingLabel, floorLabel } = group[0].room;
    const unitIds = group.flatMap(({ units }) => units.map((unit) => unit.inventoryUnitId));
    const location = buildingLabel ? physicalLabel("Building", buildingLabel) : "No building";
    options.push(createOption(
      "floor",
      `floor:${normalize(buildingLabel ?? "none")}:${normalize(floorLabel!)}`,
      physicalLabel("Floor", floorLabel!),
      `${location} - ${unitCountLabel(unitIds.length)}`,
      target("floor", { buildingLabel, floorLabel }),
      unitIds,
    ));
  }

  for (const { room, units } of sellableRooms) {
    const location = [room.buildingLabel, room.floorLabel].filter(Boolean).join(" / ");
    options.push(createOption(
      "room",
      `room:${room.roomId}`,
      room.roomName,
      [location, unitCountLabel(units.length)].filter(Boolean).join(" - "),
      target("room", { roomId: room.roomId }),
      units.map((unit) => unit.inventoryUnitId),
    ));

    for (const unit of units) {
      options.push(createOption(
        "unit",
        `unit:${unit.inventoryUnitId}`,
        unit.label,
        `${room.roomName} - ${unitKindLabel(unit.kind)}`,
        target("unit", { inventoryUnitId: unit.inventoryUnitId }),
        [unit.inventoryUnitId],
      ));
    }
  }

  return options.sort((left, right) =>
    targetOrder(left.kind) - targetOrder(right.kind) || left.label.localeCompare(right.label));
}

export function findBlockTargetOption(
  options: BlockTargetOption[],
  target: InventoryBlockTarget | null | undefined,
): BlockTargetOption | null {
  if (!target) return null;
  return options.find((option) => blockTargetsEqual(option.target, target)) ?? null;
}

export function blockTargetsEqual(left: InventoryBlockTarget, right: InventoryBlockTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 2) return normalizeNullable(left.buildingLabel) === normalizeNullable(right.buildingLabel);
  if (left.kind === 3) {
    return normalizeNullable(left.buildingLabel) === normalizeNullable(right.buildingLabel) &&
      normalizeNullable(left.floorLabel) === normalizeNullable(right.floorLabel);
  }
  if (left.kind === 4) return normalizeNullable(left.roomId) === normalizeNullable(right.roomId);
  if (left.kind === 5) return normalizeNullable(left.inventoryUnitId) === normalizeNullable(right.inventoryUnitId);
  return left.kind === 1;
}

export function groupActiveBlocks(
  blocks: ManualBlock[],
  targetOptions: BlockTargetOption[],
): ActiveBlockGroup[] {
  const blocksByGroup = groupBy(blocks, (block) => block.blockGroupId || block.blockId);
  const matchOrder: BlockTargetKind[] = ["unit", "room", "floor", "building", "property"];

  return Array.from(blocksByGroup.entries()).map(([blockGroupId, groupBlocks]) => {
    const unitIds = groupBlocks.map((block) => block.inventoryUnitId);
    const matchedTarget = matchOrder
      .flatMap((kind) => targetOptions.filter((option) => option.kind === kind))
      .find((option) => sameIds(option.unitIds, unitIds));
    const first = groupBlocks[0];

    return {
      blockGroupId,
      label: matchedTarget?.label ?? `${groupBlocks.length} inventory units`,
      detail: matchedTarget?.detail ?? unitCountLabel(groupBlocks.length),
      arrival: first.arrival,
      departure: first.departure,
      reason: first.reason,
      blocks: groupBlocks,
    };
  }).sort((left, right) => left.arrival.localeCompare(right.arrival) || left.label.localeCompare(right.label));
}

function target(
  kind: BlockTargetKind,
  values: Partial<InventoryBlockTarget> = {},
): InventoryBlockTarget {
  return {
    kind: targetKindValues[kind],
    buildingLabel: null,
    floorLabel: null,
    roomId: null,
    inventoryUnitId: null,
    ...values,
  };
}

function createOption(
  kind: BlockTargetKind,
  id: string,
  label: string,
  detail: string,
  inventoryTarget: InventoryBlockTarget,
  unitIds: string[],
): BlockTargetOption {
  return {
    id,
    kind,
    label,
    detail,
    target: inventoryTarget,
    unitIds: [...unitIds].sort(),
    searchText: `${label} ${detail}`.toLocaleLowerCase(),
  };
}

function groupBy<T>(items: T[], keySelector: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keySelector(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return left.every((value, index) => value === sortedRight[index]);
}

function physicalLabel(prefix: string, value: string): string {
  return value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) ? value : `${prefix} ${value}`;
}

function unitCountLabel(count: number): string {
  return `${count} ${count === 1 ? "sellable unit" : "sellable units"}`;
}

function unitKindLabel(kind: RoomInventory["units"][number]["kind"]): string {
  if (typeof kind === "string") return kind;
  return kind === 1 ? "room" : kind === 2 ? "bed" : "unit";
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeNullable(value: string | null): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function targetOrder(kind: BlockTargetKind): number {
  return ({ property: 0, building: 1, floor: 2, room: 3, unit: 4 } as const)[kind];
}
