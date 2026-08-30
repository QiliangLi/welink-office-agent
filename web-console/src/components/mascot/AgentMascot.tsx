import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { GROKBOT_ORIGINAL } from "../../vendor/laoa-grokbot/original-data";

type MascotMood = "working" | "waiting" | "approval" | "success" | "empty";
export type MascotScene = "idle" | "monitoring" | "waiting" | "filtering" | "create" | "inspiration" | "approval" | "success" | "empty" | "blocked";
type Point = [number, number];
type Ring = Point[];
type Expression = Ring[];

interface AgentMascotProps {
  mood?: MascotMood;
  scene?: MascotScene;
  size?: "sm" | "md" | "lg";
  className?: string;
}

interface GrokBotData {
  EXPRESSIONS: Expression[];
  POOLS: Record<string, number[]>;
  BLINK: Record<string, [number, number] | null>;
}

interface AnimationState {
  current: Expression;
  target: Expression;
  morph: number;
  velocity: number;
  last: number;
  blinkStart: number;
  gazeX: number;
  gazeY: number;
}

const DATA = GROKBOT_ORIGINAL as unknown as GrokBotData;
const BODY_PATH = "M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z";

const moodLabel: Record<MascotMood, string> = {
  working: "Agent 正在工作",
  waiting: "Agent 正在等待",
  approval: "Agent 正在等待你的确认",
  success: "Agent 已完成任务",
  empty: "当前没有待处理事项",
};

const defaultScene: Record<MascotMood, MascotScene> = {
  working: "monitoring",
  waiting: "waiting",
  approval: "approval",
  success: "success",
  empty: "empty",
};

interface SceneConfig {
  label: string;
  expressions: number[];
  motions: string[];
  expressionInterval: number;
  motionInterval: number;
  blinkState: string;
}

const combinePools = (...states: string[]) => [...new Set(states.flatMap((state) => DATA.POOLS[state] ?? []))];

const sceneConfig: Record<MascotScene, SceneConfig> = {
  idle: {
    label: "Agent 在这里陪你",
    expressions: combinePools("idle", "shy", "curious"),
    motions: ["quick-wave", "quick-peek"],
    expressionInterval: 7200,
    motionInterval: 12000,
    blinkState: "idle",
  },
  monitoring: {
    label: "Agent 正在持续跟进",
    expressions: combinePools("working", "searching", "writing", "loading"),
    motions: ["act-scan", "act-tilt", "quick-pinch"],
    expressionInterval: 2600,
    motionInterval: 6800,
    blinkState: "working",
  },
  waiting: {
    label: "Agent 正在等待新的进展",
    expressions: combinePools("listening", "idle", "drowsy"),
    motions: ["act-tilt", "quick-peek"],
    expressionInterval: 5200,
    motionInterval: 9800,
    blinkState: "listening",
  },
  filtering: {
    label: "Agent 正在帮你筛选任务",
    expressions: combinePools("curious", "listening", "thinking"),
    motions: ["act-tilt", "act-scan", "quick-peek"],
    expressionInterval: 3400,
    motionInterval: 8200,
    blinkState: "curious",
  },
  create: {
    label: "Agent 正在协助创建任务",
    expressions: combinePools("thinking", "writing", "spawning", "proud"),
    motions: ["act-tilt", "quick-pinch", "act-scan"],
    expressionInterval: 3000,
    motionInterval: 7000,
    blinkState: "thinking",
  },
  inspiration: {
    label: "Agent 正在提供任务灵感",
    expressions: combinePools("playful", "curious", "happy", "excited"),
    motions: ["quick-peek", "quick-squish", "act-tilt"],
    expressionInterval: 2500,
    motionInterval: 6500,
    blinkState: "playful",
  },
  approval: {
    label: "Agent 正在等待你的确认",
    expressions: combinePools("notifying", "listening", "suspicious", "alerting"),
    motions: ["quick-wave", "act-glitch", "quick-peek"],
    expressionInterval: 2900,
    motionInterval: 7600,
    blinkState: "notifying",
  },
  success: {
    label: "Agent 已完成任务",
    expressions: combinePools("happy", "celebrate", "proud", "laughing"),
    motions: ["quick-bounce", "quick-wave", "quick-squish"],
    expressionInterval: 2800,
    motionInterval: 7000,
    blinkState: "happy",
  },
  empty: {
    label: "当前没有待处理事项",
    expressions: combinePools("sleeping", "drowsy", "bored"),
    motions: ["act-pulse"],
    expressionInterval: 6800,
    motionInterval: 12000,
    blinkState: "sleeping",
  },
  blocked: {
    label: "Agent 遇到阻塞",
    expressions: combinePools("confused", "sad", "suspicious", "scared"),
    motions: ["act-glitch", "quick-shake", "act-tilt"],
    expressionInterval: 3300,
    motionInterval: 7800,
    blinkState: "confused",
  },
};

const cloneExpression = (expression: Expression): Expression =>
  expression.map((ring) => ring.map(([x, y]) => [x, y]));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const centroid = (ring: Ring) => ring.reduce<Point>((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0]);
const path = (ring: Ring) => `M${ring.map((point) => `${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join("L")}Z`;

function interpolatedRings(state: AnimationState) {
  const progress = clamp(state.morph, 0, 1);
  return state.current.map((ring, ringIndex) => ring.map((point, pointIndex) => [
    point[0] + (state.target[ringIndex][pointIndex][0] - point[0]) * progress,
    point[1] + (state.target[ringIndex][pointIndex][1] - point[1]) * progress,
  ] as Point));
}

function blinkScale(state: AnimationState, now: number) {
  if (!state.blinkStart) return 1;
  const progress = (now - state.blinkStart) / 320;
  if (progress >= 1) {
    state.blinkStart = 0;
    return 1;
  }
  return Math.max(progress < 0.42 ? 1 - progress / 0.42 : (progress - 0.42) / 0.58, 0.04);
}

export function AgentMascot({ mood = "working", scene, size = "md", className = "" }: AgentMascotProps) {
  const dimensions = { sm: 64, md: 98, lg: 142 }[size];
  const sceneName = scene ?? defaultScene[mood];
  const config = sceneConfig[sceneName];
  const expressionPool = config.expressions;
  const instanceId = useId();
  const instanceSeed = [...instanceId].reduce((total, character) => total + character.charCodeAt(0), 0);
  const initialExpressionIndex = instanceSeed % expressionPool.length;
  const initialExpression = expressionPool[initialExpressionIndex];
  const [motionClass, setMotionClass] = useState("");
  const clipId = `grokbot-head-${instanceId.replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const leftEyeRef = useRef<SVGPathElement>(null);
  const rightEyeRef = useRef<SVGPathElement>(null);
  const animation = useRef<AnimationState>({
    current: cloneExpression(DATA.EXPRESSIONS[initialExpression]),
    target: DATA.EXPRESSIONS[initialExpression],
    morph: 1,
    velocity: 0,
    last: performance.now(),
    blinkStart: 0,
    gazeX: 0,
    gazeY: 0,
  });

  useEffect(() => {
    const state = animation.current;
    state.current = interpolatedRings(state);
    state.target = DATA.EXPRESSIONS[initialExpression];
    state.morph = 0;
    state.velocity = 0;
    setMotionClass("");
  }, [initialExpression, sceneName]);

  useEffect(() => {
    let frameId = 0;
    const paint = (now: number) => {
      const state = animation.current;
      const delta = Math.min((now - state.last) / 1000, 0.1);
      state.last = now;
      state.velocity += (-14 * state.velocity - 49 * (state.morph - 1)) * delta;
      state.morph += state.velocity * delta;
      if (!Number.isFinite(state.morph)) {
        state.morph = 1;
        state.velocity = 0;
      }
      const shown = interpolatedRings(state);
      const blink = blinkScale(state, now);
      const eyeElements = [leftEyeRef.current, rightEyeRef.current];
      shown.forEach((ring, index) => {
        const eye = eyeElements[index];
        if (!eye) return;
        const center = centroid(ring);
        const base = Math.asin(clamp((center[0] - 114.2705) / 105, -1, 1));
        const depth = Math.cos(base);
        const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02);
        const x = 114.2705 + 105 * Math.sin(base) + state.gazeX;
        const y = center[1] + state.gazeY;
        eye.setAttribute("d", path(ring));
        eye.setAttribute("transform", `translate(${x} ${y}) scale(${clamp(perspective, 0.02, 2.4)} ${blink}) translate(${-center[0]} ${-center[1]})`);
        eye.style.opacity = depth > 0.02 ? "1" : "0";
      });
      frameId = window.requestAnimationFrame(paint);
    };
    frameId = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let expressionIndex = initialExpressionIndex;
    const expressionTimer = window.setInterval(() => {
      expressionIndex = (expressionIndex + 1) % expressionPool.length;
      const state = animation.current;
      state.current = interpolatedRings(state);
      state.target = DATA.EXPRESSIONS[expressionPool[expressionIndex]];
      state.morph = 0;
      state.velocity = 0;
    }, config.expressionInterval + (instanceSeed % 5) * 140);
    let motionIndex = instanceSeed % config.motions.length;
    const motionTimer = window.setInterval(() => {
      setMotionClass(config.motions[motionIndex]);
      motionIndex = (motionIndex + 1) % config.motions.length;
    }, config.motionInterval + (instanceSeed % 4) * 430);
    const blinkCadence = DATA.BLINK[config.blinkState];
    const blinkTimer = blinkCadence ? window.setInterval(() => {
      animation.current.blinkStart = performance.now();
    }, blinkCadence[0] + instanceSeed % Math.max(blinkCadence[1] - blinkCadence[0], 1)) : undefined;
    return () => {
      window.clearInterval(expressionTimer);
      window.clearInterval(motionTimer);
      if (blinkTimer) window.clearInterval(blinkTimer);
    };
  }, [config, expressionPool, initialExpressionIndex, instanceSeed]);

  useEffect(() => {
    if (window.matchMedia && !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const followPointer = (event: globalThis.PointerEvent) => {
      const box = rootRef.current?.getBoundingClientRect();
      if (!box) return;
      animation.current.gazeX = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -0.6, 0.6) * 22;
      animation.current.gazeY = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -0.6, 0.6) * 14;
    };
    window.addEventListener("pointermove", followPointer, { passive: true });
    return () => window.removeEventListener("pointermove", followPointer);
  }, []);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (window.matchMedia && !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    animation.current.gazeX = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -0.6, 0.6) * 22;
    animation.current.gazeY = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -0.6, 0.6) * 14;
  };

  const handlePointerLeave = () => {
    animation.current.gazeX = 0;
    animation.current.gazeY = 0;
  };

  return (
    <div
      ref={rootRef}
      className={`mascot laoa-grokbot grokbot-${mood} ${className}`}
      data-upstream="zhulin025/LaoA-GrokBot@527c3b5"
      data-grokbot-scene={sceneName}
      data-expression-count={expressionPool.length}
      data-motion-set={config.motions.join(" ")}
      style={{ "--mascot-size": `${dimensions}px` } as CSSProperties}
      role="img"
      aria-label={scene ? config.label : moodLabel[mood]}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerDown={() => { animation.current.blinkStart = performance.now(); }}
    >
      <svg className={["bot", motionClass].filter(Boolean).join(" ")} viewBox="-28 -28 285 285" aria-hidden="true">
        <defs><clipPath id={clipId}><path d={BODY_PATH} /></clipPath></defs>
        <ellipse className="orbit" cx="114" cy="115" rx="107" ry="38" />
        <g className="rainbow-rings"><ellipse cx="114" cy="116" rx="137" ry="49" /><ellipse cx="114" cy="116" rx="128" ry="64" /></g>
        <g className="body-part part-antenna"><path d="M114 18V-5" /><circle cx="114" cy="-12" r="8" /></g>
        <g className="body-part part-tail"><path d="M205 154C246 151 254 181 230 198C216 208 214 220 227 228" /></g>
        <g className="body-part part-hands"><g className="hand-left"><path d="M25 132C5 136-8 148-17 165" /><circle cx="-20" cy="170" r="10" /></g><g className="hand-right"><path d="M204 132C224 136 237 148 246 165" /><circle cx="249" cy="170" r="10" /></g></g>
        <g className="body-part part-feet"><path d="M72 202V224" /><ellipse cx="62" cy="230" rx="24" ry="10" /><path d="M157 202V224" /><ellipse cx="167" cy="230" rx="24" ry="10" /></g>
        <path className="body" d={BODY_PATH} />
        <g clipPath={`url(#${clipId})`} className="eyes"><path className="eye" ref={leftEyeRef} /><path className="eye" ref={rightEyeRef} /></g>
      </svg>
    </div>
  );
}
