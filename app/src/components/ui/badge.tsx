import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]",
        secondary:
          "border-transparent bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]",
        destructive:
          "border-transparent bg-[hsl(var(--destructive))] text-[hsl(var(--destructive-foreground))]",
        outline: "text-[hsl(var(--foreground))]",
        blue: "border-transparent bg-blue-600 text-white",
        green: "border-transparent bg-green-600 text-white",
        yellow: "border-transparent bg-yellow-600 text-black",
        purple: "border-transparent bg-purple-600 text-white",
        orange: "border-transparent bg-orange-600 text-white",
        red: "border-transparent bg-red-600 text-white",
        amber: "border-transparent bg-amber-600 text-black",
        cyan: "border-transparent bg-cyan-600 text-white",
        pink: "border-transparent bg-pink-600 text-white",
        teal: "border-transparent bg-teal-600 text-white",
        indigo: "border-transparent bg-indigo-600 text-white",
        slate: "border-transparent bg-slate-600 text-white",
        rose: "border-transparent bg-rose-600 text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
