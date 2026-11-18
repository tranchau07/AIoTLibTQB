'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
} from 'lucide-react';
import {
  filterBuildingFloorTree,
  getRoomHealthBadgeStyle,
  type FloorTreeFloorNode,
  type FloorTreeRoomNode,
} from '@/lib/floorplan/floorTreeBuilder';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type { RoomResponse } from '@/types/api';

type VisibleTreeEntry =
  | { type: 'floor'; key: string; floorNode: FloorTreeFloorNode }
  | { type: 'room'; key: string; roomNode: FloorTreeRoomNode };

export interface FloorRoomTreeProps {
  treeNodes: readonly FloorTreeFloorNode[];
  selectedFloor: number;
  selectedRoomId: string | null;
  onSelectFloor: (floor: number) => void;
  onSelectRoom: (room: RoomResponse) => void;
  defaultExpandedFloors?: readonly number[];
  defaultCollapsed?: boolean;
  isCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
}

export function FloorRoomTree({
  treeNodes,
  selectedFloor,
  selectedRoomId,
  onSelectFloor,
  onSelectRoom,
  defaultExpandedFloors,
  defaultCollapsed = false,
  isCollapsed: controlledCollapsed,
  onCollapsedChange,
  className = '',
}: FloorRoomTreeProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isCollapsed =
    controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (controlledCollapsed === undefined) {
        setInternalCollapsed(next);
      }
      onCollapsedChange?.(next);
    },
    [controlledCollapsed, onCollapsedChange]
  );

  const [expandedFloors, setExpandedFloors] = useState<Set<number>>(
    () => new Set(defaultExpandedFloors ?? [selectedFloor])
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyAlerts, setOnlyAlerts] = useState(false);

  const initialFocusKey = useMemo(() => {
    if (selectedRoomId) return `room:${selectedRoomId}`;
    const selectedF = treeNodes.find((f) => f.floor === selectedFloor);
    return selectedF?.key ?? treeNodes[0]?.key ?? '';
  }, [selectedRoomId, selectedFloor, treeNodes]);

  const [focusedKey, setFocusedKey] = useState<string>(initialFocusKey);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerNodeRef = useCallback(
    (key: string, el: HTMLDivElement | null) => {
      if (el) {
        nodeRefs.current.set(key, el);
      } else {
        nodeRefs.current.delete(key);
      }
    },
    []
  );

  // Sync reverse direction (Canvas -> Tree): auto-expand parent floor and scroll node into view when room changes
  const prevSelectedRoomIdRef = useRef<string | null>(selectedRoomId);
  useEffect(() => {
    if (!selectedRoomId) {
      prevSelectedRoomIdRef.current = null;
      return;
    }
    const ownerFloor = treeNodes.find((f) =>
      f.rooms.some((r) => r.id === selectedRoomId)
    );
    if (ownerFloor) {
      setExpandedFloors((prev) => {
        if (prev.has(ownerFloor.floor)) return prev;
        const next = new Set(prev);
        next.add(ownerFloor.floor);
        return next;
      });
      const targetKey = `room:${selectedRoomId}`;
      setFocusedKey(targetKey);
      if (prevSelectedRoomIdRef.current !== selectedRoomId) {
        prevSelectedRoomIdRef.current = selectedRoomId;
        window.requestAnimationFrame(() => {
          nodeRefs.current.get(targetKey)?.scrollIntoView?.({
            block: 'nearest',
          });
        });
      }
    }
  }, [selectedRoomId, treeNodes]);

  // Expand newly selected floor when user switches floor externally after initial mount
  const prevSelectedFloorRef = useRef<number>(selectedFloor);
  useEffect(() => {
    if (prevSelectedFloorRef.current !== selectedFloor) {
      prevSelectedFloorRef.current = selectedFloor;
      setExpandedFloors((prev) => {
        if (prev.has(selectedFloor)) return prev;
        const next = new Set(prev);
        next.add(selectedFloor);
        return next;
      });
    }
  }, [selectedFloor]);

  const isFiltering = searchQuery.trim().length > 0 || onlyAlerts;

  const filteredTree = useMemo(
    () => filterBuildingFloorTree(treeNodes, searchQuery, onlyAlerts),
    [treeNodes, searchQuery, onlyAlerts]
  );

  const visibleEntries = useMemo<VisibleTreeEntry[]>(() => {
    const entries: VisibleTreeEntry[] = [];
    for (const floorNode of filteredTree) {
      entries.push({ type: 'floor', key: floorNode.key, floorNode });
      const expanded = isFiltering || expandedFloors.has(floorNode.floor);
      if (expanded) {
        for (const roomNode of floorNode.rooms) {
          entries.push({ type: 'room', key: roomNode.key, roomNode });
        }
      }
    }
    return entries;
  }, [filteredTree, isFiltering, expandedFloors]);

  const activeRovingKey = useMemo(() => {
    if (visibleEntries.some((e) => e.key === focusedKey)) return focusedKey;
    return visibleEntries[0]?.key ?? '';
  }, [visibleEntries, focusedKey]);

  const focusNodeByKey = useCallback((key: string) => {
    setFocusedKey(key);
    const el = nodeRefs.current.get(key);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, []);

  const toggleFloorExpanded = useCallback((floor: number) => {
    setExpandedFloors((prev) => {
      const next = new Set(prev);
      if (next.has(floor)) next.delete(floor);
      else next.add(floor);
      return next;
    });
  }, []);

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, entry: VisibleTreeEntry) => {
      const currentIdx = visibleEntries.findIndex((x) => x.key === entry.key);
      if (currentIdx < 0) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = visibleEntries[currentIdx + 1];
          if (next) focusNodeByKey(next.key);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = visibleEntries[currentIdx - 1];
          if (prev) focusNodeByKey(prev.key);
          break;
        }
        case 'Home': {
          e.preventDefault();
          if (visibleEntries[0]) focusNodeByKey(visibleEntries[0].key);
          break;
        }
        case 'End': {
          e.preventDefault();
          const last = visibleEntries[visibleEntries.length - 1];
          if (last) focusNodeByKey(last.key);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          if (entry.type === 'floor') {
            const expanded =
              isFiltering || expandedFloors.has(entry.floorNode.floor);
            if (!expanded) {
              setExpandedFloors((prev) => {
                const next = new Set(prev);
                next.add(entry.floorNode.floor);
                return next;
              });
            } else if (entry.floorNode.rooms.length > 0) {
              focusNodeByKey(entry.floorNode.rooms[0].key);
            }
          }
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          if (entry.type === 'room') {
            focusNodeByKey(`floor:${entry.roomNode.floor}`);
          } else if (entry.type === 'floor') {
            const expanded = expandedFloors.has(entry.floorNode.floor);
            if (expanded && !isFiltering) {
              setExpandedFloors((prev) => {
                const next = new Set(prev);
                next.delete(entry.floorNode.floor);
                return next;
              });
            }
          }
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (entry.type === 'floor') {
            onSelectFloor(entry.floorNode.floor);
          } else {
            onSelectRoom(entry.roomNode.room);
          }
          break;
        }
      }
    },
    [
      visibleEntries,
      isFiltering,
      expandedFloors,
      focusNodeByKey,
      onSelectFloor,
      onSelectRoom,
    ]
  );

  // Collapsed Compact Strip (44px)
  if (isCollapsed) {
    return (
      <aside
        data-testid="floor-room-tree-panel"
        data-collapsed="true"
        aria-label={FLOORPLAN_I18N_VI.tree.title}
        style={{ width: '44px' }}
        className={`flex w-[44px] shrink-0 flex-col items-center gap-1.5 rounded-xl border border-slate-200/90 bg-white py-1.5 shadow-xs ${className}`}
      >
        <button
          type="button"
          data-testid="tree-collapse-toggle"
          onClick={() => setCollapsed(false)}
          aria-label={FLOORPLAN_I18N_VI.tree.expandPanel}
          title={FLOORPLAN_I18N_VI.tree.expandPanel}
          className="flex min-h-[44px] w-full items-center justify-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="h-px w-6 bg-slate-200" aria-hidden="true" />

        <div
          className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-1"
          role="group"
          aria-label="Tầng và trạng thái nhanh"
        >
          {treeNodes.map((floorNode) => {
            const style = getRoomHealthBadgeStyle(floorNode.worstStatusLevel);
            const isSelected = floorNode.floor === selectedFloor;
            return (
              <button
                key={floorNode.key}
                type="button"
                data-testid={`collapsed-floor-dot-${floorNode.floor}`}
                onClick={() => onSelectFloor(floorNode.floor)}
                aria-label={`${floorNode.label} (${style.labelVi}${floorNode.totalOpenAlerts > 0 ? `, ${floorNode.totalOpenAlerts} cảnh báo` : ''})`}
                title={`${floorNode.label} · ${style.labelVi}${floorNode.totalOpenAlerts > 0 ? ` · !${floorNode.totalOpenAlerts}` : ''}`}
                className={`relative flex min-h-[38px] w-9 flex-col items-center justify-center rounded-lg border text-[10px] font-bold transition-colors ${
                  isSelected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span>T{floorNode.floor}</span>
                <span
                  aria-hidden="true"
                  className={`mt-0.5 inline-block h-2 w-2 rounded-full ${style.dotBgClass}`}
                />
                {floorNode.totalOpenAlerts > 0 && (
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 text-[9px] font-bold ${
                      isSelected ? 'text-rose-300' : 'text-red-700'
                    }`}
                  >
                    !{floorNode.totalOpenAlerts}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="floor-room-tree-panel"
      data-collapsed="false"
      aria-label={FLOORPLAN_I18N_VI.tree.title}
      className={`flex w-full shrink-0 flex-col rounded-xl border border-slate-200/90 bg-white shadow-xs lg:w-72 ${className}`}
    >
      {/* Header + Collapse toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <span className="text-xs font-semibold text-slate-900">
          {FLOORPLAN_I18N_VI.tree.title}
        </span>
        <button
          type="button"
          data-testid="tree-collapse-toggle"
          onClick={() => setCollapsed(true)}
          aria-label={FLOORPLAN_I18N_VI.tree.collapsePanel}
          title={FLOORPLAN_I18N_VI.tree.collapsePanel}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-2xs font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Thu gọn cây</span>
        </button>
      </div>

      {/* Search + Alert Filter */}
      <div className="space-y-1.5 border-b border-slate-100 px-2.5 py-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            data-testid="tree-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={FLOORPLAN_I18N_VI.tree.searchPlaceholder}
            aria-label={FLOORPLAN_I18N_VI.tree.searchPlaceholder}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-500 focus:border-sky-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="tree-only-alerts-btn"
            aria-pressed={onlyAlerts}
            onClick={() => setOnlyAlerts((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-medium transition-colors ${
              onlyAlerts
                ? 'border-red-700 bg-red-700 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            <span>{FLOORPLAN_I18N_VI.tree.onlyAlerts}</span>
          </button>

          <span className="text-[11px] text-slate-600 tabular-nums">
            {filteredTree.reduce((sum, f) => sum + f.rooms.length, 0)} phòng
          </span>
        </div>
      </div>

      {/* WAI-ARIA Tree View */}
      <div className="max-h-[560px] flex-1 overflow-y-auto p-1.5">
        {filteredTree.length === 0 ? (
          <p
            data-testid="tree-empty-state"
            className="px-2 py-4 text-center text-xs text-slate-600"
          >
            {FLOORPLAN_I18N_VI.tree.empty}
          </p>
        ) : (
          <ul
            role="tree"
            aria-label={FLOORPLAN_I18N_VI.tree.ariaLabel}
            className="space-y-1"
          >
            {filteredTree.map((floorNode) => {
              const isExpanded =
                isFiltering || expandedFloors.has(floorNode.floor);
              const isFloorSelected =
                selectedFloor === floorNode.floor && !selectedRoomId;
              const floorStyle = getRoomHealthBadgeStyle(
                floorNode.worstStatusLevel
              );
              const floorAriaLabel = `${floorNode.label}, ${floorNode.totalRooms} phòng, ${floorStyle.labelVi}${
                floorNode.avgComfortScore !== null
                  ? `, TB ${floorNode.avgComfortScore} điểm`
                  : ''
              }${
                floorNode.totalOpenAlerts > 0
                  ? `, ${FLOORPLAN_I18N_VI.tree.openAlertCount(floorNode.totalOpenAlerts)}`
                  : ''
              }`;

              return (
                <li key={floorNode.key} role="none">
                  <div
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={isExpanded}
                    aria-selected={isFloorSelected}
                    aria-label={floorAriaLabel}
                    tabIndex={activeRovingKey === floorNode.key ? 0 : -1}
                    ref={(el) => registerNodeRef(floorNode.key, el)}
                    data-testid={`tree-floor-${floorNode.floor}`}
                    onFocus={() => setFocusedKey(floorNode.key)}
                    onKeyDown={(e) =>
                      handleTreeKeyDown(e, {
                        type: 'floor',
                        key: floorNode.key,
                        floorNode,
                      })
                    }
                    onClick={() => {
                      setFocusedKey(floorNode.key);
                      onSelectFloor(floorNode.floor);
                    }}
                    className={`flex cursor-pointer items-center justify-between gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                      isFloorSelected
                        ? 'bg-slate-900 font-semibold text-white'
                        : selectedFloor === floorNode.floor
                          ? 'bg-slate-100 font-semibold text-slate-900'
                          : 'font-medium text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        data-testid={`tree-floor-toggle-${floorNode.floor}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusedKey(floorNode.key);
                          toggleFloorExpanded(floorNode.floor);
                        }}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-black/10"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`text-[11px] font-bold ${
                          isFloorSelected
                            ? 'text-white'
                            : floorStyle.textColorClass
                        }`}
                      >
                        {floorStyle.symbol}
                      </span>
                      <span className="truncate">{floorNode.label}</span>
                      <span
                        className={`text-[10px] tabular-nums ${
                          isFloorSelected ? 'text-slate-200' : 'text-slate-600'
                        }`}
                      >
                        ({floorNode.rooms.length})
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {floorNode.avgComfortScore !== null && (
                        <span
                          className={`font-mono text-[11px] tabular-nums ${
                            isFloorSelected
                              ? 'text-slate-100'
                              : 'text-slate-700'
                          }`}
                        >
                          {floorNode.avgComfortScore}đ
                        </span>
                      )}
                      {floorNode.totalOpenAlerts > 0 && (
                        <span className="rounded-full bg-red-700 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-white tabular-nums">
                          !{floorNode.totalOpenAlerts}
                        </span>
                      )}
                    </div>
                  </div>

                  {isExpanded && floorNode.rooms.length > 0 && (
                    <ul
                      role="group"
                      aria-label={`Phòng thuộc ${floorNode.label}`}
                      className="mt-0.5 space-y-0.5 pl-4"
                    >
                      {floorNode.rooms.map((roomNode) => {
                        const isRoomSelected = selectedRoomId === roomNode.id;
                        const roomStyle = getRoomHealthBadgeStyle(
                          roomNode.statusLevel
                        );
                        const roomAriaLabel = `${roomNode.code} ${roomNode.name}, ${roomStyle.labelVi}${
                          roomNode.comfortScore !== null
                            ? `, ${roomNode.comfortScore} điểm`
                            : ''
                        }${
                          roomNode.openAlertsCount > 0
                            ? `, ${FLOORPLAN_I18N_VI.tree.openAlertCount(roomNode.openAlertsCount)}`
                            : ''
                        }`;

                        return (
                          <li key={roomNode.key} role="none">
                            <div
                              role="treeitem"
                              aria-level={2}
                              aria-selected={isRoomSelected}
                              aria-label={roomAriaLabel}
                              tabIndex={
                                activeRovingKey === roomNode.key ? 0 : -1
                              }
                              ref={(el) => registerNodeRef(roomNode.key, el)}
                              data-testid={`tree-room-${roomNode.code}`}
                              data-room-id={roomNode.id}
                              onFocus={() => setFocusedKey(roomNode.key)}
                              onKeyDown={(e) =>
                                handleTreeKeyDown(e, {
                                  type: 'room',
                                  key: roomNode.key,
                                  roomNode,
                                })
                              }
                              onClick={() => {
                                setFocusedKey(roomNode.key);
                                onSelectRoom(roomNode.room);
                              }}
                              className={`flex cursor-pointer items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                                isRoomSelected
                                  ? 'bg-sky-700 font-semibold text-white'
                                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                              }`}
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className={`shrink-0 text-[10px] font-bold ${
                                    isRoomSelected
                                      ? 'text-white'
                                      : roomStyle.textColorClass
                                  }`}
                                >
                                  {roomNode.symbol}
                                </span>
                                <span className="truncate">
                                  <span className="font-mono font-semibold">
                                    {roomNode.shortCode}
                                  </span>{' '}
                                  <span
                                    className={
                                      isRoomSelected
                                        ? 'text-sky-100'
                                        : 'text-slate-600'
                                    }
                                  >
                                    {roomNode.name}
                                  </span>
                                </span>
                              </div>

                              <div className="flex shrink-0 items-center gap-1">
                                {roomNode.comfortScore !== null && (
                                  <span
                                    className={`font-mono text-[10px] tabular-nums ${
                                      isRoomSelected
                                        ? 'text-white'
                                        : 'text-slate-700'
                                    }`}
                                  >
                                    {roomNode.comfortScore}đ
                                  </span>
                                )}
                                {roomNode.openAlertsCount > 0 && (
                                  <span className="rounded-full bg-red-700 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-white tabular-nums">
                                    !{roomNode.openAlertsCount}
                                  </span>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
