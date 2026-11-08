import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-token text-[13px] font-medium whitespace-nowrap transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent-hover active:opacity-85",
        secondary: "bg-hover text-fg hover:bg-active active:bg-active",
        ghost: "text-fg hover:bg-hover active:bg-active",
        outline: "border border-line text-fg hover:bg-hover active:bg-active",
        danger: "bg-danger text-white hover:opacity-90 active:opacity-80",
      },
      size: {
        sm: "h-[26px] px-2",
        default: "h-[30px] px-3",
        lg: "h-8 px-4",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
