'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  History,
  Lock,
  Redo2,
  RotateCw,
  Save,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react';
import {
  FURNITURE_CATALOG,
  filterVisibleFurnitureCatalog,
  resolveFurnitureCatalogEntry,
  type FurnitureCatalogEntry,
} from '@/config/furniture-catalog';
import { formatVietnamDateTime } from '@/lib/format/datetime';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import {
  alignFurnitureItems,
  clampFurnitureDimensions,
  isFurnitureInsideRoom,
  metersToNormalizedPoint,
  normalizedToMetersPoint,
  snapNormalizedPointToGrid,
  snapToGridMeters,
  validateFurnitureLayout,
  type FurnitureAlignMode,
  type FurnitureValidationResult,
} from '@/lib/floorplan/furnitureGeometry';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  FurnitureAuditEntry,
  FurnitureItem,
  Point2D,
  RoomResponse,
} from '@/types/api';

export interface FurnitureLayerEditorProps {
  room: RoomResponse;
  roomPolygon: readonly Point2D[];
  catalog?: readonly FurnitureCatalogEntry[];
  hideSensitive?: boolean;
  items: readonly FurnitureItem[];
  canUndo: boolean;
  canRedo: boolean;
  selectedIds: readonly string[];
  onSelectIds: (ids: string[]) => void;
  onCommitItems: (nextItems: FurnitureItem[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  validation?: FurnitureValidationResult;
  snapEnabled: boolean;
  onSnapEnabledChange: (enabled: boolean) => void;
  showLayer: boolean;
  onShowLayerChange: (show: boolean) => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  version: number | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
  auditHistory: readonly FurnitureAuditEntry[];
  isSaving?: boolean;
  hasConflict?: boolean;
  errorMessage?: string | null;
  isReadOnlyPreset?: boolean;
  onSave: (changeNote?: string) => void;
  onReload: () => void;
  onExitEdit?: () => void;
}

function generateFurnitureId(typeId: string): string {
  const slug = typeId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const rand = Math.random().toString(36).slice(2, 7);
  return `furn_${slug}_${Date.now().toString(36)}_${rand}`;
}

export function FurnitureLayerEditor({
  room,
  roomPolygon,
  catalog = FURNITURE_CATALOG,
  hideSensitive = false,
  items,
  canUndo,
  canRedo,
  selectedIds,
  onSelectIds,
  onCommitItems,
  onUndo,
  onRedo,
  validation: externalValidation,
  snapEnabled,
  onSnapEnabledChange,
  showLayer,
  onShowLayerChange,
  opacity,
  onOpacityChange,
  version,
  updatedBy,
  updatedAt,
  auditHistory,
  isSaving = false,
  hasConflict = false,
  errorMessage = null,
  isReadOnlyPreset = false,
  onSave,
  onReload,
  onExitEdit,
}: FurnitureLayerEditorProps) {
  const [changeNote, setChangeNote] = useState<string>('');

  const visibleCatalog = useMemo(
    () => filterVisibleFurnitureCatalog(catalog, hideSensitive),
    [catalog, hideSensitive]
  );

  const validation = useMemo(
    () =>
      externalValidation ?? validateFurnitureLayout(items, roomPolygon, catalog),
    [externalValidation, items, roomPolygon, catalog]
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(
    () => items.filter((it) => selectedSet.has(it.id)),
    [items, selectedSet]
  );
  const singleItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const anySelectedUnlocked = selectedItems.some((it) => !it.locked);
  const anySelectedLocked = selectedItems.some((it) => it.locked);

  // Global keyboard shortcuts inside edit mode (Ctrl+Z Undo, Ctrl+Y / Ctrl+Shift+Z Redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (isTextInput) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (canRedo) onRedo();
        } else if (canUndo) {
          onUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        if (isTextInput) return;
        e.preventDefault();
        if (canRedo) onRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, onUndo, onRedo]);

  const handleAddItem = (entry: FurnitureCatalogEntry) => {
    const baseCenter =
      roomPolygon.length >= 3
        ? computeVisualPolygonCenter(roomPolygon)
        : { x: 0.5, y: 0.5 };
    const dims = clampFurnitureDimensions(
      entry.defaultWidthM,
      entry.defaultDepthM,
      entry.typeId,
      catalog
    );

    const offsetsM: Array<{ dx: number; dy: number }> = [
      { dx: 0, dy: 0 },
      { dx: 2.5, dy: 0 },
      { dx: -2.5, dy: 0 },
      { dx: 0, dy: 2.0 },
      { dx: 0, dy: -2.0 },
      { dx: 2.5, dy: 2.0 },
      { dx: -2.5, dy: -2.0 },
      { dx: 5.0, dy: 0 },
      { dx: -5.0, dy: 0 },
    ];
    const baseM = normalizedToMetersPoint(baseCenter);

    let chosenNorm = snapEnabled
      ? snapNormalizedPointToGrid(baseCenter, 0.25)
      : baseCenter;

    for (const off of offsetsM) {
      const candM = { x: baseM.x + off.dx, y: baseM.y + off.dy };
      const candNormRaw = metersToNormalizedPoint(candM);
      const candNorm = snapEnabled
        ? snapNormalizedPointToGrid(candNormRaw, 0.25)
        : candNormRaw;
      const candidateItem: FurnitureItem = {
        id: 'probe',
        typeId: entry.typeId,
        label: entry.shortLabel,
        x: Number(candNorm.x.toFixed(4)),
        y: Number(candNorm.y.toFixed(4)),
        widthM: dims.widthM,
        depthM: dims.depthM,
        rotationDeg: 0,
        locked: false,
      };
      const candidateList = [...items, candidateItem];
      if (
        isFurnitureInsideRoom(candidateItem, roomPolygon) &&
        validateFurnitureLayout(candidateList, roomPolygon, catalog).valid
      ) {
        chosenNorm = candNorm;
        break;
      }
    }

    const nextItem: FurnitureItem = {
      id: generateFurnitureId(entry.typeId),
      typeId: entry.typeId,
      label: entry.shortLabel,
      x: Number(chosenNorm.x.toFixed(4)),
      y: Number(chosenNorm.y.toFixed(4)),
      widthM: dims.widthM,
      depthM: dims.depthM,
      rotationDeg: 0,
      locked: false,
    };

    onCommitItems([...items, nextItem]);
    onSelectIds([nextItem.id]);
  };

  const updateSingleItem = (
    itemId: string,
    updater: (prev: FurnitureItem) => FurnitureItem
  ) => {
    const target = items.find((i) => i.id === itemId);
    if (!target || target.locked) return;
    const next = items.map((it) => (it.id === itemId ? updater(it) : it));
    onCommitItems(next);
  };

  const handleDuplicateSelected = () => {
    if (selectedItems.length === 0) return;
    const clones: FurnitureItem[] = selectedItems.map((it, idx) => {
      const ptM = normalizedToMetersPoint({ x: it.x, y: it.y });
      const rawOffset = metersToNormalizedPoint({
        x: ptM.x + 1.0 + idx * 0.25,
        y: ptM.y + 1.0 + idx * 0.25,
      });
      const snapped = snapEnabled
        ? snapNormalizedPointToGrid(rawOffset, 0.25)
        : rawOffset;
      const clampedCenter = isFurnitureInsideRoom(
        { ...it, x: snapped.x, y: snapped.y },
        roomPolygon
      )
        ? snapped
        : { x: it.x, y: it.y };

      return {
        ...it,
        id: generateFurnitureId(it.typeId),
        label: it.label ? `${it.label} (bản sao)` : undefined,
        x: Number(clampedCenter.x.toFixed(4)),
        y: Number(clampedCenter.y.toFixed(4)),
        locked: false,
      };
    });

    onCommitItems([...items, ...clones]);
    onSelectIds(clones.map((c) => c.id));
  };

  const handleToggleLockSelected = () => {
    if (selectedItems.length === 0) return;
    const shouldLock = selectedItems.some((it) => !it.locked);
    onCommitItems(
      items.map((it) =>
        selectedSet.has(it.id) ? { ...it, locked: shouldLock } : it
      )
    );
  };

  const handleDeleteSelected = () => {
    if (!anySelectedUnlocked) return;
    const next = items.filter(
      (it) => !(selectedSet.has(it.id) && !it.locked)
    );
    const remainingSelected = selectedIds.filter((id) =>
      next.some((it) => it.id === id)
    );
    onCommitItems(next);
    onSelectIds(remainingSelected);
  };

  const handleAlign = (mode: FurnitureAlignMode) => {
    const aligned = alignFurnitureItems(items, selectedIds, mode, roomPolygon);
    onCommitItems(aligned);
  };

  const singleMeters = singleItem
    ? normalizedToMetersPoint({ x: singleItem.x, y: singleItem.y })
    : null;

  return (
    <div
      data-testid="furniture-layer-editor"
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
        <div>
          <h3 className="text-xs font-bold text-slate-900">
            {FLOORPLAN_I18N_VI.furniture.paletteTitle}
          </h3>
          <p className="text-[11px] text-slate-500">
            {room.code} · {FLOORPLAN_I18N_VI.furniture.versionLabel(version)}
            {updatedBy ? ` · ${updatedBy}` : ''}
            {updatedAt ? ` · ${formatVietnamDateTime(updatedAt)}` : ''}
          </p>
        </div>
        {onExitEdit && (
          <button
            type="button"
            data-testid="furniture-exit-edit-btn"
            onClick={onExitEdit}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
          >
            {FLOORPLAN_I18N_VI.furniture.exitEdit}
          </button>
        )}
      </div>

      {/* Optimistic Lock 409 Conflict Banner */}
      {hasConflict && (
        <div
          role="alert"
          data-testid="furniture-conflict-banner"
          className="space-y-1.5 rounded-lg border border-amber-400 bg-amber-50 p-2.5 text-amber-950"
        >
          <p className="text-[11px] font-semibold">
            {FLOORPLAN_I18N_VI.furniture.conflictBanner}
          </p>
          <button
            type="button"
            data-testid="furniture-reload-btn"
            onClick={onReload}
            className="rounded-md border border-amber-700 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
          >
            {FLOORPLAN_I18N_VI.furniture.reloadButton}
          </button>
        </div>
      )}

      {errorMessage && !hasConflict && (
        <div
          role="alert"
          data-testid="furniture-error-banner"
          className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-2 text-[11px] font-medium text-rose-800"
        >
          {errorMessage}
        </div>
      )}

      {isReadOnlyPreset && (
        <div className="rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-2 text-[11px] text-slate-700">
          {FLOORPLAN_I18N_VI.furniture.presetReadonlyHint}
        </div>
      )}

      {/* Visibility, Opacity & Snap Controls */}
      <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex items-center gap-1.5 font-medium text-slate-800">
            <input
              type="checkbox"
              data-testid="furniture-layer-visibility-toggle"
              checked={showLayer}
              onChange={(e) => onShowLayerChange(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600"
            />
            <span>{FLOORPLAN_I18N_VI.furniture.layerToggle}</span>
          </label>

          <label className="inline-flex items-center gap-1.5 font-medium text-slate-800">
            <input
              type="checkbox"
              data-testid="furniture-snap-toggle"
              checked={snapEnabled}
              onChange={(e) => onSnapEnabledChange(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600"
            />
            <span>{FLOORPLAN_I18N_VI.furniture.snapGridLabel}</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-slate-600">
            {FLOORPLAN_I18N_VI.furniture.opacityLabel}:
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            aria-label={FLOORPLAN_I18N_VI.furniture.opacityLabel}
            data-testid="furniture-opacity-slider"
            onChange={(e) =>
              onOpacityChange(
                Math.max(0, Math.min(1, Number(e.target.value) / 100))
              )
            }
            className="h-1.5 flex-1 accent-sky-600"
          />
          <span className="w-9 text-right font-mono text-[11px] font-semibold text-slate-700 tabular-nums">
            {Math.round(opacity * 100)}%
          </span>
        </div>
      </div>

      {/* Catalog Palette (Data-driven from catalog prop) */}
      <div className="grid grid-cols-2 gap-1.5">
        {visibleCatalog.map((entry) => (
          <button
            key={entry.typeId}
            type="button"
            data-testid={`furniture-catalog-add-${entry.typeId}`}
            onClick={() => handleAddItem(entry)}
            className="flex flex-col items-start rounded-lg border border-slate-200 bg-white p-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/60"
          >
            <span className="line-clamp-1 font-semibold text-slate-900">
              + {entry.labelVi}
            </span>
            <span className="font-mono text-[10px] text-slate-500">
              {entry.defaultWidthM.toFixed(1)}×{entry.defaultDepthM.toFixed(1)}m
            </span>
          </button>
        ))}
      </div>

      {/* Undo / Redo & Item Action Toolbar */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1.5">
        <button
          type="button"
          data-testid="furniture-undo-btn"
          disabled={!canUndo}
          onClick={onUndo}
          title={`${FLOORPLAN_I18N_VI.furniture.undoButton} (Ctrl+Z)`}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{FLOORPLAN_I18N_VI.furniture.undoButton}</span>
        </button>

        <button
          type="button"
          data-testid="furniture-redo-btn"
          disabled={!canRedo}
          onClick={onRedo}
          title={`${FLOORPLAN_I18N_VI.furniture.redoButton} (Ctrl+Y)`}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{FLOORPLAN_I18N_VI.furniture.redoButton}</span>
        </button>

        <span className="mx-0.5 h-4 w-px bg-slate-200" aria-hidden="true" />

        <button
          type="button"
          data-testid="furniture-duplicate-btn"
          disabled={selectedItems.length === 0}
          onClick={handleDuplicateSelected}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{FLOORPLAN_I18N_VI.furniture.duplicateButton}</span>
        </button>

        <button
          type="button"
          data-testid="furniture-lock-btn"
          disabled={selectedItems.length === 0}
          onClick={handleToggleLockSelected}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          {anySelectedLocked && !anySelectedUnlocked ? (
            <>
              <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{FLOORPLAN_I18N_VI.furniture.unlockButton}</span>
            </>
          ) : (
            <>
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{FLOORPLAN_I18N_VI.furniture.lockButton}</span>
            </>
          )}
        </button>

        <button
          type="button"
          data-testid="furniture-delete-btn"
          disabled={!anySelectedUnlocked}
          onClick={handleDeleteSelected}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{FLOORPLAN_I18N_VI.furniture.deleteButton}</span>
        </button>
      </div>

      {/* Multi-select Alignment Bar */}
      {selectedItems.length >= 2 && (
        <div
          data-testid="furniture-align-bar"
          className="space-y-1.5 rounded-lg border border-sky-200 bg-sky-50/70 p-2"
        >
          <p className="text-[11px] font-semibold text-sky-950">
            {FLOORPLAN_I18N_VI.furniture.alignTitle} ({selectedItems.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {(
              [
                {
                  mode: 'left' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.left,
                  icon: AlignStartVertical,
                },
                {
                  mode: 'centerX' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.centerX,
                  icon: AlignCenterVertical,
                },
                {
                  mode: 'right' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.right,
                  icon: AlignEndVertical,
                },
                {
                  mode: 'top' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.top,
                  icon: AlignStartHorizontal,
                },
                {
                  mode: 'middleY' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.middleY,
                  icon: AlignCenterHorizontal,
                },
                {
                  mode: 'bottom' as FurnitureAlignMode,
                  label: FLOORPLAN_I18N_VI.furniture.alignActions.bottom,
                  icon: AlignEndHorizontal,
                },
              ] as const
            ).map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                data-testid={`furniture-align-${mode}`}
                onClick={() => handleAlign(mode)}
                className="inline-flex items-center gap-1 rounded border border-sky-200 bg-white px-1.5 py-1 text-[10px] font-medium text-slate-800 hover:bg-sky-100"
              >
                <Icon className="h-3 w-3 text-sky-700" aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}

            {selectedItems.length >= 3 && (
              <>
                <button
                  type="button"
                  data-testid="furniture-align-distributeX"
                  onClick={() => handleAlign('distributeX')}
                  className="rounded border border-sky-200 bg-white px-1.5 py-1 text-[10px] font-medium text-slate-800 hover:bg-sky-100"
                >
                  {FLOORPLAN_I18N_VI.furniture.alignActions.distributeX}
                </button>
                <button
                  type="button"
                  data-testid="furniture-align-distributeY"
                  onClick={() => handleAlign('distributeY')}
                  className="rounded border border-sky-200 bg-white px-1.5 py-1 text-[10px] font-medium text-slate-800 hover:bg-sky-100"
                >
                  {FLOORPLAN_I18N_VI.furniture.alignActions.distributeY}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Room Items List */}
      <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5">
        {items.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-slate-400">
            {FLOORPLAN_I18N_VI.furniture.emptyRoom}
          </p>
        ) : (
          items.map((item) => {
            const entry = resolveFurnitureCatalogEntry(item.typeId, catalog);
            const isSelected = selectedSet.has(item.id);
            const isInvalid = validation.invalidIds.has(item.id);
            return (
              <div
                key={item.id}
                data-testid={`furniture-list-item-${item.id}`}
                onClick={(ev) => {
                  if (ev.shiftKey) {
                    if (isSelected) {
                      onSelectIds(selectedIds.filter((id) => id !== item.id));
                    } else {
                      onSelectIds([...selectedIds, item.id]);
                    }
                  } else {
                    onSelectIds([item.id]);
                  }
                }}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2 py-1 transition-colors ${
                  isInvalid
                    ? 'border-rose-400 bg-rose-50 text-rose-900'
                    : isSelected
                      ? 'border-sky-500 bg-sky-50 text-slate-900'
                      : 'border-slate-100 bg-slate-50/40 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    aria-label={`Chọn ${item.label || entry.shortLabel}`}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={(ev) => {
                      if (ev.target.checked) {
                        onSelectIds([...selectedIds, item.id]);
                      } else {
                        onSelectIds(selectedIds.filter((id) => id !== item.id));
                      }
                    }}
                    className="h-3 w-3 rounded border-slate-300 text-sky-600"
                  />
                  <span className="truncate font-medium">
                    {item.label || entry.shortLabel}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
                  <span>
                    {item.widthM.toFixed(1)}×{item.depthM.toFixed(1)}m
                  </span>
                  <span>{Math.round(item.rotationDeg)}°</span>
                  {item.locked && (
                    <Lock
                      className="h-3 w-3 text-amber-600"
                      aria-label="Đã khóa"
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Single Selected Item Property Inspector */}
      {singleItem && singleMeters && (
        <div
          data-testid="furniture-item-inspector"
          className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-slate-800">
              {FLOORPLAN_I18N_VI.furniture.itemInspectorTitle}
            </span>
            <span className="font-mono text-[10px] text-slate-500">
              {singleItem.typeId}
            </span>
          </div>

          {singleItem.locked && (
            <p
              data-testid="furniture-locked-hint"
              className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
            >
              {FLOORPLAN_I18N_VI.furniture.lockedHint}
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 block">
              <span className="text-[10px] font-medium text-slate-500">
                {FLOORPLAN_I18N_VI.furniture.labelField}
              </span>
              <input
                type="text"
                disabled={singleItem.locked}
                data-testid="furniture-input-label"
                value={singleItem.label ?? ''}
                onChange={(e) =>
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    label: e.target.value,
                  }))
                }
                className="input mt-0.5 h-7 w-full text-xs disabled:bg-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-medium text-slate-500">
                {FLOORPLAN_I18N_VI.furniture.xMetersField}
              </span>
              <input
                type="number"
                step={snapEnabled ? 0.25 : 0.1}
                disabled={singleItem.locked}
                data-testid="furniture-input-xm"
                value={Number(singleMeters.x.toFixed(2))}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isFinite(val)) return;
                  const nextM = snapEnabled
                    ? snapToGridMeters(val, 0.25)
                    : val;
                  const norm = metersToNormalizedPoint({
                    x: nextM,
                    y: singleMeters.y,
                  });
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    x: Number(norm.x.toFixed(4)),
                  }));
                }}
                className="input mt-0.5 h-7 w-full font-mono text-xs disabled:bg-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-medium text-slate-500">
                {FLOORPLAN_I18N_VI.furniture.yMetersField}
              </span>
              <input
                type="number"
                step={snapEnabled ? 0.25 : 0.1}
                disabled={singleItem.locked}
                data-testid="furniture-input-ym"
                value={Number(singleMeters.y.toFixed(2))}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isFinite(val)) return;
                  const nextM = snapEnabled
                    ? snapToGridMeters(val, 0.25)
                    : val;
                  const norm = metersToNormalizedPoint({
                    x: singleMeters.x,
                    y: nextM,
                  });
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    y: Number(norm.y.toFixed(4)),
                  }));
                }}
                className="input mt-0.5 h-7 w-full font-mono text-xs disabled:bg-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-medium text-slate-500">
                {FLOORPLAN_I18N_VI.furniture.widthField}
              </span>
              <input
                type="number"
                step={0.1}
                disabled={singleItem.locked}
                data-testid="furniture-input-width"
                value={singleItem.widthM}
                onChange={(e) => {
                  const rawW = Number(e.target.value);
                  if (!Number.isFinite(rawW)) return;
                  const clamped = clampFurnitureDimensions(
                    rawW,
                    singleItem.depthM,
                    singleItem.typeId,
                    catalog
                  );
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    widthM: clamped.widthM,
                  }));
                }}
                className="input mt-0.5 h-7 w-full font-mono text-xs disabled:bg-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-medium text-slate-500">
                {FLOORPLAN_I18N_VI.furniture.depthField}
              </span>
              <input
                type="number"
                step={0.1}
                disabled={singleItem.locked}
                data-testid="furniture-input-depth"
                value={singleItem.depthM}
                onChange={(e) => {
                  const rawD = Number(e.target.value);
                  if (!Number.isFinite(rawD)) return;
                  const clamped = clampFurnitureDimensions(
                    singleItem.widthM,
                    rawD,
                    singleItem.typeId,
                    catalog
                  );
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    depthM: clamped.depthM,
                  }));
                }}
                className="input mt-0.5 h-7 w-full font-mono text-xs disabled:bg-slate-100"
              />
            </label>

            <div className="col-span-2 flex items-end gap-1.5">
              <label className="flex-1 block">
                <span className="text-[10px] font-medium text-slate-500">
                  {FLOORPLAN_I18N_VI.furniture.rotationField}
                </span>
                <input
                  type="number"
                  step={15}
                  disabled={singleItem.locked}
                  data-testid="furniture-input-rotation"
                  value={singleItem.rotationDeg}
                  onChange={(e) => {
                    const rawDeg = Number(e.target.value);
                    if (!Number.isFinite(rawDeg)) return;
                    const normalizedDeg = ((rawDeg % 360) + 360) % 360;
                    updateSingleItem(singleItem.id, (prev) => ({
                      ...prev,
                      rotationDeg: normalizedDeg,
                    }));
                  }}
                  className="input mt-0.5 h-7 w-full font-mono text-xs disabled:bg-slate-100"
                />
              </label>

              <button
                type="button"
                disabled={singleItem.locked}
                data-testid="furniture-rotate-45-btn"
                onClick={() =>
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    rotationDeg: (prev.rotationDeg + 45) % 360,
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <RotateCw className="h-3 w-3" aria-hidden="true" />
                <span>+45°</span>
              </button>

              <button
                type="button"
                disabled={singleItem.locked}
                data-testid="furniture-rotate-90-btn"
                onClick={() =>
                  updateSingleItem(singleItem.id, (prev) => ({
                    ...prev,
                    rotationDeg: (prev.rotationDeg + 90) % 360,
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <span>+90°</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Geometry / Collision Validation Summary */}
      {!validation.valid && (
        <div
          role="alert"
          data-testid="furniture-validation-errors"
          className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-2 text-[11px] text-rose-800"
        >
          {validation.outOfBoundsIds.size > 0 && (
            <p className="font-semibold">
              • {FLOORPLAN_I18N_VI.furniture.outOfBoundsError} (
              {validation.outOfBoundsIds.size} đối tượng)
            </p>
          )}
          {validation.overlappingPairs.length > 0 && (
            <p className="font-semibold">
              • {FLOORPLAN_I18N_VI.furniture.overlapError} (
              {validation.overlappingPairs.length} cặp)
            </p>
          )}
        </div>
      )}

      {/* Save Layout Footer */}
      <div className="space-y-2 border-t border-slate-200 pt-2">
        <label className="block">
          <span className="text-[10px] font-medium text-slate-500">
            {FLOORPLAN_I18N_VI.furniture.changeNoteLabel}
          </span>
          <input
            type="text"
            maxLength={200}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder={FLOORPLAN_I18N_VI.furniture.changeNotePlaceholder}
            className="input mt-0.5 h-7 w-full text-xs"
          />
        </label>

        <button
          type="button"
          data-testid="furniture-save-btn"
          disabled={!validation.valid || isSaving || isReadOnlyPreset}
          onClick={() => onSave(changeNote.trim() || undefined)}
          className="btn-primary btn-sm flex w-full items-center justify-center gap-1.5 disabled:opacity-45"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            {isSaving
              ? FLOORPLAN_I18N_VI.furniture.savingButton
              : FLOORPLAN_I18N_VI.furniture.saveButton}
          </span>
        </button>
      </div>

      {/* Audit History */}
      <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] font-semibold text-slate-700">
          <span className="inline-flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
            <span>{FLOORPLAN_I18N_VI.furniture.auditTitle}</span>
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            {auditHistory.length}
          </span>
        </summary>
        <div
          data-testid="furniture-audit-history"
          className="mt-2 max-h-28 space-y-1.5 overflow-y-auto border-t border-slate-100 pt-1.5 text-[11px]"
        >
          {auditHistory.length === 0 ? (
            <p className="text-slate-400">
              {FLOORPLAN_I18N_VI.furniture.auditEmpty}
            </p>
          ) : (
            auditHistory.map((entry, idx) => (
              <div
                key={`${entry.version}-${entry.timestamp}-${idx}`}
                className="rounded border border-slate-100 bg-slate-50/70 px-2 py-1"
              >
                <div className="flex items-center justify-between gap-2 font-semibold text-slate-800">
                  <span>{entry.username}</span>
                  <span className="font-mono text-[10px] text-sky-700">
                    v{entry.version}
                  </span>
                </div>
                <p className="text-slate-600">{entry.actionSummary}</p>
                <p className="text-[10px] text-slate-400">
                  {entry.timestamp ? formatVietnamDateTime(entry.timestamp) : ''}
                </p>
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  );
}
