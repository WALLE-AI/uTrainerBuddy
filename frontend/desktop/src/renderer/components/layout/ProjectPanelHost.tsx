/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layout-level Project Panel host (stage3 FULL / P1–P4). This is the project's
 * right-side panel host: it owns the column's width, border and lifecycle, and
 * mounts a self-contained project component inside. The titlebar owns the desktop
 * collapse control. The hosted component is {@link ProjectWorkbench}; the host is
 * named generically (not `ProjectExplorerColumn`) so future project-scoped
 * components (source-control, kanban, …) can mount through the same seam without
 * re-architecting the host — no plugin framework is introduced this round.
 *
 * The workbench manages conversation context, tabs and the persistent Explorer.
 * Width and collapse callbacks remain owned by the Layout host.
 *
 * Rendered as a sibling of the route `<Outlet>`, above the per-conversation
 * subtree, so switching conversations within the same project does NOT remount it
 * — WS subscriptions, tree and preview stay live (no teardown, no flicker).
 * Collapsing shrinks the column to width 0 (kept mounted) rather than
 * unmounting, so collapse/expand also preserves state. `data-mount-id` (once per
 * mount) is the live-test proof it is not remounted across switches or collapse.
 */

import React, { useRef } from 'react';
import { dispatchWorkspaceToggleEvent } from '@renderer/utils/workspace/workspaceEvents';

import { ProjectWorkbench } from './ProjectWorkbench';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';

export type ProjectPanelHostProps = {
  /** Rendered width in px (clamped by Layout against the chat+preview reserve). */
  widthPx: number;
  /** Collapsed → width 0, component kept mounted (no remount). */
  collapsed: boolean;
  /** Left-edge resize handle from Layout's `useResizableSplit`. */
  dragHandle?: React.ReactNode;
  onToggleWidth?: () => void;
  expanded?: boolean;
};

export const ProjectPanelHost: React.FC<ProjectPanelHostProps> = ({ widthPx, collapsed, dragHandle, onToggleWidth, expanded }) => {
  const projectId = useCurrentProject();
  const mountIdRef = useRef<string>('');
  if (mountIdRef.current === '') mountIdRef.current = `pec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // No active project (no-project conversation / non-chat route) → no host.
  if (!projectId) return null;

  return (
    <div
      data-project-panel-host
      data-explorer-column
      data-mount-id={mountIdRef.current}
      data-collapsed={collapsed ? 'true' : 'false'}
      inert={collapsed}
      aria-hidden={collapsed}
      className='!bg-1 h-full flex-shrink-0 overflow-hidden relative trainer-project-workbench'
      style={{
        width: collapsed ? '0px' : `${widthPx}px`,
        borderLeft: collapsed ? 'none' : '1px solid var(--bg-3)',
      }}
    >
      {!collapsed && dragHandle}
      <ProjectWorkbench key={projectId} projectId={projectId} collapsed={collapsed} onCollapse={dispatchWorkspaceToggleEvent} onToggleWidth={onToggleWidth} expanded={expanded} />
    </div>
  );
};
