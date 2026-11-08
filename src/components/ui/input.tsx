import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-[var(--ctl-h)] w-full rounded-token border border-line bg-elevated px-2.5 text-[13px] text-fg",
        "placeholder:text-muted/70 hover:border-muted/50 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

/** 与 Input 视觉一致的原生 select（避免额外依赖） */
export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-[var(--ctl-h)] w-full rounded-token border border-line bg-elevated px-2 text-[13px] text-fg",
        "hover:border-muted/50 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = "Select";
