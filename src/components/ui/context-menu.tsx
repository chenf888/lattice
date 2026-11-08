import * as MenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "@/lib/utils";

export const ContextMenu = MenuPrimitive.Root;
export const ContextMenuTrigger = MenuPrimitive.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>): ReactElement {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        className={cn(
          "z-50 min-w-36 rounded-token border border-line bg-elevated p-1 text-[13px] text-fg shadow-pop focus:outline-none",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item>): ReactElement {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-token px-2 py-1.5 outline-none",
        "data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>): ReactElement {
  return <MenuPrimitive.Separator className={cn("my-1 h-px bg-line", className)} {...props} />;
}
