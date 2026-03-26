"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap border border-transparent font-bold uppercase tracking-wider outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-[10px] sm:h-4.5 sm:min-w-4.5 sm:text-[9px]",
        lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-xs sm:h-5.5 sm:min-w-5.5 sm:text-[10px]",
        sm: "h-5 min-w-5 px-[calc(--spacing(1)-1px)] text-[9px] sm:h-4 sm:min-w-4 sm:text-[8px]",
      },
      variant: {
        default: "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/80",
        destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/80",
        error: "border-destructive/40 bg-destructive/15 text-destructive-foreground",
        info: "border-info/40 bg-info/15 text-info-foreground",
        outline:
          "border-white/20 bg-transparent text-foreground [button&,a&]:hover:bg-white/8",
        secondary: "bg-white/8 text-secondary-foreground [button&,a&]:hover:bg-white/15",
        success: "border-success/40 bg-success/15 text-success-foreground",
        warning: "border-warning/40 bg-warning/15 text-warning-foreground",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
