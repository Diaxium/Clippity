import { Check } from "lucide-react";
import { motion } from "motion/react";

/**
 * The celebratory checkmark used on every Complete step: an accent ring
 * that scales in, a check that pops, and a ring of sparkles. Purely
 * decorative (`aria-hidden`) — the surrounding heading carries meaning.
 */
export function SuccessBurst({ size = 92 }: { size?: number }) {
  // Eight sparkles evenly around the ring.
  const sparkles = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);

  return (
    <div
      aria-hidden
      className="relative grid place-items-center"
      style={{ width: size * 1.7, height: size * 1.7 }}
    >
      {sparkles.map((angle, i) => {
        const radius = size * 0.82;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        return (
          <motion.span
            key={i}
            className="absolute rounded-full bg-[var(--color-accent)]"
            style={{ width: 6, height: 6 }}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
            animate={{ x, y, opacity: [0, 1, 0.7], scale: [0, 1, 0.8] }}
            transition={{ delay: 0.15 + i * 0.03, duration: 0.7, ease: "easeOut" }}
          />
        );
      })}

      <motion.div
        className="grid place-items-center rounded-full"
        style={{
          width: size,
          height: size,
          background: "var(--color-accent-soft)",
          boxShadow:
            "0 0 0 2px color-mix(in srgb, var(--color-accent) 55%, transparent), 0 0 34px color-mix(in srgb, var(--color-accent) 40%, transparent)",
        }}
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 20 }}
      >
        <motion.span
          className="grid place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-ink)]"
          style={{ width: size * 0.62, height: size * 0.62 }}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.12, type: "spring", stiffness: 400, damping: 18 }}
        >
          <Check size={size * 0.32} strokeWidth={3} />
        </motion.span>
      </motion.div>
    </div>
  );
}
