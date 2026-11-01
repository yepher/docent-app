import { useEffect, useRef, useState } from 'react';
import type { DocSet, Topic, TopicMap, TopicPassage } from '../../shared/types';

const CAMERA_DISTANCE = 3.2;
const LABELS_SHOWN = 10;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const HIT_PADDING = 5;
const POINT_HIT = 6;

interface View {
  yaw: number;
  pitch: number;
  zoom: number;
}

interface Screen {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

const color = (topic: number, alpha = 1) => `hsl(${(topic * 137.508) % 360} 62% 55% / ${alpha})`;
const radiusOf = (topic: Topic, largest: number) => 5 + 13 * Math.sqrt(topic.documentCount / Math.max(largest, 1));
const placeOf = (p: TopicPassage) =>
  p.page !== null ? `${p.title}, page ${p.page}` : p.line !== null ? `${p.title}, line ${p.line}` : p.title;
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function project([x, y, z]: [number, number, number], view: View, width: number, height: number): Screen {
  const cosY = Math.cos(view.yaw);
  const sinY = Math.sin(view.yaw);
  const cosP = Math.cos(view.pitch);
  const sinP = Math.sin(view.pitch);
  const rx = x * cosY + z * sinY;
  const rz = -x * sinY + z * cosY;
  const ry = y * cosP - rz * sinP;
  const depth = y * sinP + rz * cosP;
  const scale = (CAMERA_DISTANCE / (CAMERA_DISTANCE + depth)) * view.zoom * (Math.min(width, height) * 0.36);
  return { x: width / 2 + rx * scale, y: height / 2 + ry * scale, depth, scale };
}

/** A rotatable t-SNE map of a set's topics. Hovering a topic shows how it connects to the others. */
export function TopicMapView({ set, onClose, revealLabel }: { set: DocSet; onClose: () => void; revealLabel: string }) {
  const [map, setMap] = useState<TopicMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; passage: TopicPassage } | null>(null);
  const [passage, setPassage] = useState<TopicPassage | null>(null);
  const moved = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ yaw: 0.6, pitch: -0.3, zoom: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const screens = useRef<{ topics: Screen[]; points: Screen[] }>({ topics: [], points: [] });
  const draw = useRef<() => void>(() => {});

  useEffect(() => {
    const load = () => void window.api.sets.topics(set.id).then((m) => (setMap(m), setLoaded(true)));
    load();
    const stopProgress = window.api.sets.onProgress((p) => {
      setStage(p?.setId === set.id ? (p.current ?? 'Reading files') : null);
      if (p === null) load();
    });
    const stopChanges = window.api.sets.onTopicsChanged((id) => {
      if (id === set.id) load();
    });
    return () => {
      stopProgress();
      stopChanges();
    };
  }, [set.id]);

  useEffect(() => {
    if (!map) return;
    const target = canvas.current;
    const context = target?.getContext('2d');
    if (!target || !context) return;
    // Canvas cannot parse the light-dark() in a CSS variable, so this reads the resolved color.
    const style = getComputedStyle(target);
    const largest = Math.max(...map.topics.map((t) => t.documentCount));
    const labeled = new Set([...map.topics].sort((a, b) => b.documentCount - a.documentCount).slice(0, LABELS_SHOWN).map((t) => t.id));
    const active = focus === null ? undefined : map.topics[focus];
    const linked = new Map(active?.related.map((r, i) => [r.topic, 1 - i / (active.related.length + 1)]) ?? []);

    draw.current = () => {
      const ratio = window.devicePixelRatio;
      const width = target.clientWidth;
      const height = target.clientHeight;
      if (target.width !== Math.round(width * ratio) || target.height !== Math.round(height * ratio)) {
        target.width = Math.round(width * ratio);
        target.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const points = map.points.map((p) => project(p.position, view.current, width, height));
      const topics = map.topics.map((t) => project(t.position, view.current, width, height));
      screens.current = { topics, points };

      points.forEach((screen, i) => {
        const topic = map.points[i]!.topic;
        const lit = active === undefined || topic === active.id || linked.has(topic);
        context.fillStyle = color(topic, lit ? 0.8 : 0.15);
        context.beginPath();
        context.arc(screen.x, screen.y, Math.max(2, screen.scale / 110), 0, Math.PI * 2);
        context.fill();
      });

      if (active) {
        const from = topics[active.id]!;
        for (const [other, strength] of linked) {
          const to = topics[other]!;
          context.strokeStyle = style.color;
          context.globalAlpha = 0.25 + 0.6 * strength;
          context.lineWidth = 1 + 3 * strength;
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        }
        context.globalAlpha = 1;
      }

      const order = map.topics.map((t) => t.id).sort((a, b) => topics[b]!.depth - topics[a]!.depth);
      for (const id of order) {
        const topic = map.topics[id]!;
        const screen = topics[id]!;
        const lit = active === undefined || id === active.id || linked.has(id);
        context.fillStyle = color(id, lit ? 0.95 : 0.2);
        context.beginPath();
        context.arc(screen.x, screen.y, radiusOf(topic, largest), 0, Math.PI * 2);
        context.fill();
        if (id === active?.id || linked.has(id) || (active === undefined && labeled.has(id))) {
          context.fillStyle = style.color;
          context.font = `${id === active?.id ? 600 : 400} 12px ${style.fontFamily}`;
          const radius = radiusOf(topic, largest);
          const fits = screen.x + radius + 4 + context.measureText(topic.label).width <= width;
          context.textAlign = fits ? 'left' : 'right';
          context.fillText(topic.label, screen.x + (fits ? radius + 4 : -radius - 4), screen.y + 4);
        }
      }
    };
    draw.current();
    const observer = new ResizeObserver(() => draw.current());
    observer.observe(target);
    return () => observer.disconnect();
  }, [map, focus]);

  const hit = (x: number, y: number) => {
    if (!map) return null;
    const largest = Math.max(...map.topics.map((t) => t.documentCount));
    let topic: number | null = null;
    let nearest = Infinity;
    screens.current.topics.forEach((screen, i) => {
      const distance = Math.hypot(screen.x - x, screen.y - y);
      if (distance <= radiusOf(map.topics[i]!, largest) + HIT_PADDING && distance < nearest) {
        topic = i;
        nearest = distance;
      }
    });
    if (topic !== null) return { topic, passage: null };
    let point: number | null = null;
    nearest = POINT_HIT;
    screens.current.points.forEach((screen, i) => {
      const distance = Math.hypot(screen.x - x, screen.y - y);
      if (distance < nearest) {
        point = i;
        nearest = distance;
      }
    });
    if (point === null) return null;
    return { topic: map.points[point]!.topic, passage: map.points[point]! as TopicPassage };
  };

  const active = map && focus !== null ? map.topics[focus] : undefined;
  const sorted = map ? [...map.topics].sort((a, b) => b.documentCount - a.documentCount) : [];

  return (
    <section className="topic-view" aria-label={`Topic map of ${set.name}`}>
      <header>
        <span className="scope">
          Topic map of {set.name}
          {map && `: ${plural(map.topics.length, 'topic')} from ${plural(map.passageCount, 'passage')}`}
        </span>
        <button onClick={onClose}>Close map</button>
      </header>
      {!map ? (
        <p className="topic-message">
          {stage
            ? `${stage}. The map appears when this finishes.`
            : loaded
              ? set.chunkCount < 12
                ? 'This set is too small to group into topics yet.'
                : 'Topics are waiting to be built. The map appears when they are ready.'
              : 'Loading…'}
        </p>
      ) : (
        <>
          <div className="topic-stage">
            <canvas
              ref={canvas}
              aria-label="3D map of topics. The list beside it has the same topics."
              role="img"
              onMouseDown={(e) => {
                drag.current = { x: e.clientX, y: e.clientY };
                moved.current = false;
              }}
              onClick={(e) => {
                if (moved.current) return;
                const box = e.currentTarget.getBoundingClientRect();
                const found = hit(e.clientX - box.left, e.clientY - box.top);
                setPassage(found?.passage ?? null);
                if (found) setFocus(found.topic);
              }}
              onMouseUp={() => (drag.current = null)}
              onMouseLeave={() => {
                drag.current = null;
                setTip(null);
              }}
              onMouseMove={(e) => {
                if (drag.current) {
                  moved.current = true;
                  view.current.yaw += (e.clientX - drag.current.x) * 0.008;
                  view.current.pitch = Math.max(-1.5, Math.min(1.5, view.current.pitch + (e.clientY - drag.current.y) * 0.008));
                  drag.current = { x: e.clientX, y: e.clientY };
                  draw.current();
                  return;
                }
                const box = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - box.left;
                const y = e.clientY - box.top;
                const found = hit(x, y);
                if (found) setFocus(found.topic);
                setTip(found?.passage ? { x, y, passage: found.passage } : null);
              }}
              onWheel={(e) => {
                view.current.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.current.zoom * Math.exp(-e.deltaY * 0.001)));
                draw.current();
              }}
            />
            {tip && (
              <div className="topic-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
                <p>{tip.passage.snippet}</p>
                <small>{placeOf(tip.passage)}. Click to keep this open.</small>
              </div>
            )}
            <p className="fine">Each dot is a passage, and nearby dots mean similar things. Drag to rotate, scroll to zoom.</p>
          </div>
          <aside className="topic-panel">
            {passage && (
              <div className="topic-passage">
                <h4>Selected passage</h4>
                <PassageCard passage={passage} revealLabel={revealLabel} />
                <button onClick={() => setPassage(null)}>Clear</button>
              </div>
            )}
            {active ? (
              <>
                <button className="back" onClick={() => (setFocus(null), setPassage(null))}>All topics</button>
                <h3>{active.label}</h3>
                {active.summary && <p>{active.summary}</p>}
                <p className="fine">
                  {plural(active.documentCount, 'document')}, {plural(active.passageCount, 'passage')}
                </p>
                <p className="fine">Common words: {active.keywords.join(', ')}</p>
                <h4>Typical passages</h4>
                <ul>
                  {active.examples.map((example, i) => (
                    <li key={i}>
                      <button onClick={() => setPassage(example)}>
                        {example.snippet}
                        <small>{placeOf(example)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
                <h4>Connected topics</h4>
                {active.related.length === 0 && <p className="fine">No strong connections.</p>}
                <ul>
                  {active.related.map((link) => (
                    <li key={link.topic}>
                      <button onClick={() => setFocus(link.topic)}>
                        {map.topics[link.topic]!.label}
                        <small>
                          {plural(link.sharedDocuments, 'shared document')}, {plural(link.passages, 'bridging passage')}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
                <h4>Main documents</h4>
                <ul>
                  {active.titles.map((title) => (
                    <li key={title} className="fine">{title}</li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <h3>Topics</h3>
                <p className="fine">Largest first.</p>
                <ul>
                  {sorted.map((topic) => (
                    <li key={topic.id}>
                      <button onClick={() => setFocus(topic.id)}>
                        {topic.label}
                        {topic.summary && <small>{topic.summary}</small>}
                        <small>{plural(topic.documentCount, 'document')}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </>
      )}
    </section>
  );
}

function PassageCard({ passage, revealLabel }: { passage: TopicPassage; revealLabel: string }) {
  return (
    <>
      <blockquote>{passage.snippet}</blockquote>
      <p className="fine">{placeOf(passage)}</p>
      <div className="actions">
        <button onClick={() => void window.api.docs.open(passage.documentId)}>Open file</button>
        <button onClick={() => void window.api.docs.reveal(passage.documentId)}>{revealLabel}</button>
      </div>
    </>
  );
}
