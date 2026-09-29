/**
 * 菜单与弹出层：基于 Radix（下拉菜单、右键菜单、弹出层），样式遵循主题变量。
 * 注意：在原生 <dialog> 里打开时需要把 Portal 的 container 指向该 dialog，否则会被顶层遮住。
 */
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

const CONTENT = 'menu-content';
const ITEM = 'menu-item';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownTrigger = DropdownMenuPrimitive.Trigger;
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextTrigger = ContextMenuPrimitive.Trigger;

export function DropdownContent({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content className={CONTENT} align={align} sideOffset={6} collisionPadding={8}>
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownItem({
  children,
  onSelect,
  danger,
  disabled,
  checked,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item className={ITEM} data-danger={danger || undefined} disabled={disabled} onSelect={onSelect}>
      <span className="w-4 flex-none">{checked ? <Check size={14} /> : null}</span>
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownMenuPrimitive.Separator className="menu-separator" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <DropdownMenuPrimitive.Label className="menu-label">{children}</DropdownMenuPrimitive.Label>;
}

export function DropdownSub({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenuPrimitive.Sub>
      <DropdownMenuPrimitive.SubTrigger className={ITEM}>
        <span className="w-4 flex-none" />
        <span className="flex-1">{label}</span>
        <ChevronRight size={14} />
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent className={`${CONTENT} max-h-[60vh] overflow-y-auto`} sideOffset={4} collisionPadding={8}>
          {children}
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
  );
}

export function ContextContent({ children, container }: { children: ReactNode; container?: HTMLElement | null }) {
  return (
    <ContextMenuPrimitive.Portal {...(container ? { container } : {})}>
      <ContextMenuPrimitive.Content className={CONTENT} collisionPadding={8}>
        {children}
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item className={ITEM} data-danger={danger || undefined} disabled={disabled} onSelect={onSelect}>
      <span className="w-4 flex-none" />
      {children}
    </ContextMenuPrimitive.Item>
  );
}

export function ContextLabel({ children }: { children: ReactNode }) {
  return <ContextMenuPrimitive.Label className="menu-label">{children}</ContextMenuPrimitive.Label>;
}

export function ContextSeparator() {
  return <ContextMenuPrimitive.Separator className="menu-separator" />;
}

export function ContextSub({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger className={ITEM}>
        <span className="w-4 flex-none" />
        <span className="flex-1">{label}</span>
        <ChevronRight size={14} />
      </ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.SubContent className={`${CONTENT} max-h-[60vh] overflow-y-auto`} sideOffset={4} collisionPadding={8}>
          {children}
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  children,
  align = 'start',
  container,
  className = '',
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  container?: HTMLElement | null;
  className?: string;
}) {
  return (
    <PopoverPrimitive.Portal {...(container ? { container } : {})}>
      <PopoverPrimitive.Content className={`${CONTENT} p-0 ${className}`} align={align} sideOffset={6} collisionPadding={8}>
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
