import type { Transition, Variants } from "motion/react";

// ===== Easing curves =====
export const EASE_MATERIAL = [0.4, 0, 0.2, 1] as const;
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

// ===== Page / route transitions =====
export const pageTransition: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE_MATERIAL } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.24, ease: EASE_MATERIAL } },
};

// ===== List item enter / exit =====
export const listItemVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, y: -8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -8 },
};

export const listItemTransition: Transition = {
  duration: 0.18,
  ease: EASE_OUT_EXPO,
};

// ===== Stagger container =====
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
  exit: {
    transition: {
      staggerChildren: 0.02,
      staggerDirection: -1,
    },
  },
};

// ===== Collapse / expand =====
export const collapseVariants: Variants = {
  collapsed: { height: 0, opacity: 0 },
  open: { height: "auto", opacity: 1 },
};

export const collapseTransition: Transition = {
  duration: 0.2,
  ease: EASE_MATERIAL,
};

// ===== Toast / notification =====
export const toastVariants: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 16 },
};

export const toastTransition: Transition = {
  duration: 0.18,
  ease: "easeOut",
};

// ===== Scale fade (HUD / overlay) =====
export const scaleFadeVariants: Variants = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
};

export const scaleFadeTransition: Transition = {
  duration: 0.18,
  ease: EASE_OUT_EXPO,
};

// ===== Slide (panel / drawer) =====
export const slideLeftVariants: Variants = {
  initial: { x: "-100%" },
  animate: { x: 0 },
  exit: { x: "-100%" },
};

export const slideTransition: Transition = {
  duration: 0.28,
  ease: EASE_MATERIAL,
};

// ===== Spring configs =====
export const SPRING_NOTIFICATION = {
  damping: 30,
  stiffness: 320,
  type: "spring",
} as const;

export const SPRING_LAYOUT = {
  damping: 26,
  mass: 0.4,
  stiffness: 380,
  restDelta: 0.5,
  restSpeed: 2,
  type: "spring",
} as const;
