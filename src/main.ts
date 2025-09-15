/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    map,
    scan,
    switchMap,
    take,
    animationFrames,
    merge,
    pairwise
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const BIRB_X = Viewport.CANVAS_WIDTH*0.3 - Birb.WIDTH/2;

const Constants = {
    PIPE_WIDTH: 50,
    GRAVITY_RATE: 0.001,
    FLAP_RATE: 0.30,
    MAX_UP: 0.60,
    MAX_DOWN: 0.55,
    MAX_FRAMES: 33,
    PIPE_SPEED: 120,
    COLLISION_COOLDOWN: 800,
    MARGIN: 5,
    BOUNCE_MIN: 0.30,
    BOUNCE_MAX: 0.75,
} as const;

type Milliseconds = number;

// State processing

type BirbState = Readonly <{
    y: number;
    vy: number;
}>;

// Ghost replay
type Ghost=Readonly<{t:Milliseconds; y: number}>;
type Collision = "TOP" | "BOTTOM" | null; // null if no collision

type Action =
    | {type:"FLAP"}
    | {type:"TICK"; dt: number; rand: number}
    | {type:"RESTART"};

type PipeSpawn = Readonly<{
    at: number;
    gapY: number;
    gapHeight: number;
}>;

type Pipe = Readonly<{
    id: number;
    x: number;
    gapY: number;
    gapHeight: number;
    passed: boolean;
}>;

type State = Readonly<{
    gameEnd: boolean;
    time: Milliseconds;
    birb: BirbState;
    pipes: ReadonlyArray<Pipe>;
    remainingPipeSpawns: ReadonlyArray<PipeSpawn>;
    hp: number;
    totalPipeSpawns: ReadonlyArray<PipeSpawn>;
    lastHitTime: Milliseconds;
    score: number;
    totalPipes: number;
    ghost: ReadonlyArray<Ghost>;
    track: ReadonlyArray<Ghost>;
}>;
/** 
 * Functional helper that clamps a number o a closed interval
 * @param x Value to clamp.
 * @param low Lower bound (inclusive)
 * @param high Upper bound (inclusive)
 * @returns The value of x constrained to [low, high]
 */
const clamp =(
    x:number,
    low:number,
    high:number
) => Math.max(low, Math.min(high,x));

/**
 * Computes the top y coordinate in px of a pipes gap
 * @param p Pipe descriptor
 * @returns Top of the gap in canvas pixels
 */
const GapTop = (p:Pipe) =>
    p.gapY*Viewport.CANVAS_HEIGHT - (p.gapHeight*Viewport.CANVAS_HEIGHT)/2;

/**
 * Computes the bottom Y coordinate in px of a pipes gap
 * @param p Pipe descriptor
 * @returns Bottom of the gap in canvas pixels
 */
const GapBottom = (p:Pipe) =>
    p.gapY*Viewport.CANVAS_HEIGHT + (p.gapHeight*Viewport.CANVAS_HEIGHT)/2;

/**
 * Pure reducer: finds the next pipe id (max(id)+1)
 * @param pipes Existing pipes (immutable)
 * @returns Next id for a newly spawned pipe
 */
const nextPipe=(pipes:ReadonlyArray<Pipe>) =>
    pipes.reduce((acc, p) => (p.id > acc? p.id : acc), -1) + 1;
/**
 * Constructs the initial bird state
 * @returns Immutable initial BirbState
 */
const makeBirb=(): BirbState=> ({
    y: Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT/2,
    vy:0,
});

/**
 * Functional array partition
 * @param xs Source array (immutable)
 * @param pred Predicate to split items
 * @returns A tuple [yes, no] where 'yes' satisfies pred
 */
const partition = <T,>( // split array
  xs: ReadonlyArray<T>,
  pred: (t: T) => boolean, // predicate function
): [ReadonlyArray<T>, ReadonlyArray<T>] => // returns tuple of two arrays
  xs.reduce<[T[], T[]]>(
    ([a, b], v) => (pred(v) ? [[...a, v], b] : [a, [...b, v]]), 
    [[], []], // initial values
  );

/**
 * Creates the initial game
 * @param lives Precomputed pipe schedule - gapY, gapHeight, at ms
 * @returns Immutable initial State.
 */
const initialState = (pipeSpawn: ReadonlyArray<PipeSpawn>): State => { // start game
    const seedGapY = pipeSpawn[0]?.gapY ?? 0.5; 
    const seedGapHeight = pipeSpawn[0]?.gapHeight ?? 0.25; 

    const seed: Pipe = { // first pipe
        id: 0,
        x: Viewport.CANVAS_WIDTH - Constants.PIPE_WIDTH, 
        gapY: seedGapY,
        gapHeight: seedGapHeight,
        passed: false,
    };

    return {
        gameEnd: false,
        time: 0,
        birb: makeBirb(),
        pipes: [seed],
        remainingPipeSpawns:pipeSpawn.slice(),
        hp: 3, // number of hearts
        totalPipeSpawns: pipeSpawn.slice(), 
        lastHitTime: -Constants.COLLISION_COOLDOWN, // dont allow immediate collision
        score: 0,
        totalPipes: pipeSpawn.length + 1, // +1 for the initial pipe
        ghost: [],
        track: [],
    };
};

/**
 * Resets the game but preserves the ghost replay
 * @param prev Previous terminal State
 * @returns New initial State with ghost data from last game
 */
const restartState = (prev: State): State => { //restart
  const ns = initialState(prev.totalPipeSpawns as PipeSpawn[]);
  return { ...ns, ghost: prev.ghost };
};



/**
 *Collision test between bird and world
 * @param b Current bird kinematics (y, vy).
 * @param pipes Current pipes.
 * @returns "TOP" | "BOTTOM" | null where null = no collision.
 */
const checkCollision = (b: BirbState, pipes: ReadonlyArray<Pipe>): Collision =>
  b.y <= Constants.MARGIN
    ? "TOP"
    : b.y + Birb.HEIGHT >= Viewport.CANVAS_HEIGHT - Constants.MARGIN
    ? "BOTTOM"
    : (() => {
        const hit = pipes.find((p) => { // check each pipe
          const withinX = // check x overlap
            BIRB_X + Birb.WIDTH > p.x && BIRB_X < p.x + Constants.PIPE_WIDTH; // overlap
          if (!withinX) return false; // no x overlap, no collision
          const gt = GapTop(p); 
          const gb = GapBottom(p);
          const inGap = b.y > gt && b.y + Birb.HEIGHT < gb; // check y overlap
          return !inGap; // if not in gap, collision
        });
        return hit ? (b.y <= GapTop(hit) ? "TOP" : "BOTTOM") : null; //hit top or bottom
      })();

/**
 * CSV to PipeSpawn parser.
 * Expected headers: gap_y, gap_height, time (seconds)
 * @param csv Raw text
 * @returns Sorted, clamped, validated PipeSpawn in ms.
 */
function parseCSV (csv: string): PipeSpawn[] {
    const lines = csv.trim().split(/\r?\n/).filter(l => l.trim().length > 0); //split lines and remove empty
    const [headerLine, ...rows] = lines;
    const header = headerLine.split(",").map(s => s.trim());
    const idx = (h: string) => header.findIndex((x) => x === h); 
    const gapYIdx = idx("gap_y");
    const gapHeightIdx = idx("gap_height");
    const timeIdx = idx("time");

    const toNum = (s:string, def:number) => { //str to num
        const n = Number(s);
        return Number.isFinite(n) ? n : def;
    };

    const clamp01 = (x: number) => clamp(x, 0, 1); // 0 to 1

  return rows //reads each row and maps to PipeSpawn
    .map((line) => line.split(",").map((s) => s.trim()))
    .map((cols) => ({
      gapY: clamp01(toNum(cols[gapYIdx], 0.5)),
      gapHeight: clamp01(toNum(cols[gapHeightIdx], 0.25)),
      at: Math.max(0, Math.round(toNum(cols[timeIdx], 0) * 1000)),
    }))
    .sort((a, b) => a.at - b.at);
};

/**
 *FRP state transition function
 * @param s Prior immutable state
 * @param a actions "FLAP" | "TICK" | "RESTART"
 * @returns New immutable state
 */
const reduceState = (s: State, a: Action): State => 
  s.gameEnd // if game ended
    ? a.type === "RESTART" // restart on restart action
      ? restartState(s)
      : s
    : ((): State => { // game ongoing
        switch (a.type) {
          case "FLAP": { // flap action
            const vy = -Math.min(Constants.FLAP_RATE, Constants.MAX_UP);
            return { ...s, birb: { ...s.birb, vy } };
          }
          case "TICK": { // tick action to update states
            const dt = clamp(a.dt, 0, Constants.MAX_FRAMES);
            const time = s.time + dt;
            const sec = dt / 1000;

            // spawn and move pipes
            const [due, rest] = partition(s.remainingPipeSpawns, (ps) => ps.at <= time);
            const baseId = nextPipe(s.pipes);
            const spawned = due.map((sp, i) => ({
              id: baseId + i,
              x: Viewport.CANVAS_WIDTH,
              gapY: sp.gapY,
              gapHeight: sp.gapHeight,
              passed: false,
            }));
            // move pipes and remove offscreen ones
            const pipesMoved = s.pipes
              .concat(spawned)
              .map((p) => ({ ...p, x: p.x - Constants.PIPE_SPEED * sec }))
              .filter((p) => p.x + Constants.PIPE_WIDTH > 0);

            // move birb
            const vy0 = s.birb.vy + Constants.GRAVITY_RATE * dt;
            const vy = clamp(vy0, -Constants.MAX_UP, Constants.MAX_DOWN);
            const y = clamp(
              s.birb.y + vy * dt,
              0,
              Viewport.CANVAS_HEIGHT - Birb.HEIGHT,
            );

            // scoring
            const prevPassed = 
                new Set(s.pipes.filter((p) => p.passed).map((p) => p.id));
            const betweenPipes = 
                (p: Pipe) => y >= GapTop(p) && y + Birb.HEIGHT <= GapBottom(p);
            const canCount = 
                (p: Pipe) => BIRB_X > p.x + Constants.PIPE_WIDTH && betweenPipes(p);

            const newlyPassedIds = pipesMoved // pipes that are newly passed
              .filter((p) => !prevPassed.has(p.id) && canCount(p))
              .map((p) => p.id);

            const newPassedSet = new Set(newlyPassedIds);
            const pipes = pipesMoved.map((p) =>
              newPassedSet.has(p.id) ? { ...p, passed: true } : p,
            );
            const score = s.score + newlyPassedIds.length;

            // collisions
            const canCollide = time - s.lastHitTime >= Constants.COLLISION_COOLDOWN;
            const hit = canCollide ? checkCollision({ y, vy }, pipes) : null;

            const bounceVelocity =
              a.rand * (Constants.BOUNCE_MAX - Constants.BOUNCE_MIN) +
              Constants.BOUNCE_MIN;

            const vyAfter = // bounce effect
              hit === "TOP" ? clamp(+bounceVelocity, -Constants.MAX_UP, Constants.MAX_DOWN)
              : hit === "BOTTOM" ? clamp(-bounceVelocity, -Constants.MAX_UP, Constants.MAX_DOWN)
              : vy;

            const yAfter = // no sticking to top/bottom
              hit === null
                ? y
                : clamp(
                    y,
                    1,
                    Viewport.CANVAS_HEIGHT - Birb.HEIGHT - 1,
                  );

            const hp = Math.max(0, s.hp - (hit ? 1 : 0));
            const lastHitTime = hit ? time : s.lastHitTime;

           // track for ghost
            const track = s.track.concat([{ t: time, y: yAfter }]);
            const willEnd = hp === 0 || (rest.length === 0 && pipes.length === 0);
            const ghost = willEnd ? track : s.ghost;

            return {
                ...s,
                time,
                birb: { y: yAfter, vy: vyAfter},
                pipes,
                remainingPipeSpawns: rest,
                lastHitTime,
                hp,
                score,
                gameEnd: willEnd,
                track: willEnd ? [] : track, // reset track if game will end
                ghost, //last run
            };
          }
          case "RESTART":
            return s;
        }
    })();

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const toForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/**
 * Renders the current State to canvas
 * @param s Current State snapshot
 */
const render = (): ((s: State) => void) => { //render game

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement; //screen

    svg.setAttribute( // set screen size
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    const namespace = svg.namespaceURI; //svg namespace

    /**
     * checks that <image> element exists in the SVG
     * @param id Element id
     * @param href Image source
     * @param x Left position in px
     * @param y Top position in px
     * @param w Width in px
     * @param h Height in px
     * @returns The existing or newly-created SVGImageElement
     */
    const checkForImage = (id: string, href: string, x: number, y: number, w: number, h: number) => { //check if image exists, else make
        const found = document.getElementById(id) as SVGImageElement | null;
        return found ?? ((): SVGImageElement => {
            const img = createSvgElement(namespace, "image", {
                id, href: href, x: String(x), y: String(y),
                width: String(w), height: String(h),
            }) as SVGImageElement;
            svg.appendChild(img);
            return img;
        })();
    };

    /**
     * Checks that a <div> element exists in the document
     * @param id Element id
     * @param style CSS styles to apply
     * @param text Initial text content
     * @returns The existing or newly-created HTMLDivElement
     */
    const checkForDiv = (id: string, style: Partial<CSSStyleDeclaration>, text = "") => { //check if div exists, else make
        const el = document.getElementById(id) as HTMLDivElement | null;
        return el ?? ((): HTMLDivElement => {
            const d = document.createElement("div");
            d.id = id;
            Object.assign(d.style, style);
            d.textContent = text;
            document.body.appendChild(d);
            return d;
        })();
    };

    /**
     * checks that a pipe <g> element exists in the SVG
     * @param id Element id
     * @returns The existing or newly-created SVGGElement
     */
    const ensurePipeGroup = (id: string) => { // check if pipe group exists, else make
        const found = document.getElementById(id) as SVGGElement | null;
        return found ?? ((): SVGGElement => {
            const g = document.createElementNS(namespace, "g") as SVGGElement;
            g.setAttribute("id", id);
            g.setAttribute("data-pipe", "1");
            // children rects
            const top = createSvgElement(namespace, "rect", { id:`${id}-top`});
            const bottom = createSvgElement(namespace, "rect", { id:`${id}-bot`});
            g.appendChild(top);
            g.appendChild(bottom);
            svg.appendChild(g);
            return g;
        })();
    };

    const birbImg = checkForImage("birbImg", "assets/birb.png", 
        BIRB_X, Viewport.CANVAS_HEIGHT /2 -Birb.HEIGHT/2, Birb.WIDTH, Birb.HEIGHT);

    const ghostImage = ((): SVGImageElement => {
        const img = checkForImage("ghostImage", "assets/birb.png",
            BIRB_X, Viewport.CANVAS_HEIGHT/2 - Birb.HEIGHT/2, Birb.WIDTH, Birb.HEIGHT);
        img.style.opacity = "0.35";
        img.style.filter = "grayscale(100%)";
        img.setAttribute("visibility", "hidden");
        return img;
    })();

    const livesText = checkForDiv("livesText", {
        position: "absolute",
        left:"10px",
        top:"10px",
        color: "white",
        fontSize: "20px",
        fontFamily:"Arial, sans-serif",
        textShadow: "2px 2px 4px #000000",
        display: "block"
    });

    const scoreText = checkForDiv("scoreText", {
        position: "absolute",
        right: "12px",
        top: "8px",
        color: "white",
        font: "600 16px system-ui, sans-serif",
        textShadow: "0 1px 2px rgba(0,0,0,.6)"
    });

    const gameOver = checkForDiv("gameOver", {
        position: "absolute",
        justifyContent: "center",
        alignItems: "center",
        color: "red",
        fontSize: "40px",
        fontFamily: "Arial, sans-serif",
        display: "none"
    }, "Game Over! Play again.");

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        // Add birb to the main grid canvas

        birbImg.setAttribute("y", `${s.birb.y}`);
        birbImg.setAttribute("x", `${BIRB_X}`);

        const desiredIds = s.pipes.map(p => `pipe-${p.id}`); // pipe ids that should exist

        s.pipes.forEach(p => { //checks if pipe exists, creates/updates
            const id = `pipe-${p.id}`;
            const g = ensurePipeGroup(id);
            const gapTop= GapTop(p);
            const gapBottom= GapBottom(p);
            const [top, bottom] = Array.from(g.children) as [SVGRectElement, SVGRectElement];

            top.setAttribute("x", `${p.x}`);
            top.setAttribute("y", `0`);
            top.setAttribute("width", `${Constants.PIPE_WIDTH}`);
            top.setAttribute("height", `${gapTop}`);
            top.setAttribute("fill", "green");

            bottom.setAttribute("x",`${p.x}`);
            bottom.setAttribute("y",`${gapBottom}`);
            bottom.setAttribute("width", `${Constants.PIPE_WIDTH}`);
            bottom.setAttribute("height", `${Viewport.CANVAS_HEIGHT - gapBottom}`);
            bottom.setAttribute("fill", "green");

        });
        Array.from(svg.querySelectorAll<SVGGElement>('g[data-pipe="1"]')) // remove pipes that shouldnt exist / offscreen
            .filter(g => !desiredIds.includes(g.id))
            .forEach(g => g.remove());

        livesText.textContent = `${s.hp}`; //update pipeSpawn text
        gameOver.style.display = s.gameEnd ? "flex" : "none"; // show game over
        scoreText!.textContent = `${s.score}`; //update score text

        const gs = s.ghost;
        if (gs.length === 0) {// no ghost
            ghostImage.setAttribute("visibility", "hidden");
        } else { // position ghost
            const i = gs.findIndex(g => g.t > s.time); // first ghost point after current time
            if (i === -1) {
                // farther than last game
                ghostImage!.setAttribute("visibility", "hidden");
            } else {
                const idx = Math.max(0, i - 1);
                const gy = gs[idx].y;
                ghostImage!.setAttribute("x", String(BIRB_X));
                ghostImage!.setAttribute("y", String(gy));
                ghostImage!.setAttribute("visibility", "visible");
            }
        }
        // keep bird above
        toForeground(birbImg);
    };
};

export const state$ = (csvContents: string): Observable<State> => { // main game observable
    /** User input */

    const key$ = fromEvent<KeyboardEvent>(document, "keydown");
    const pipeSpawn = parseCSV(csvContents); // pipe spawn data
    const initial = initialState(pipeSpawn);

    const flap$ = key$.pipe( // when space is pressed
        filter(e => e.code === "Space" && !e.repeat),
        map((): Action => ({ type: "FLAP" })) //calls flap action
    );

    const restart$ = fromEvent(document, "mousedown").pipe(map((): Action => ({ type: "RESTART" }))); // restart on click

    const hashRand = (t: number) => { //random num gen
        // pure, deterministic in [0,1)
        const x = Math.sin(t * 0.001 *12.99) * 43758.5453;
        return x - Math.floor(x);
    };

    /** Determines the rate of time steps */
    const tick$ = animationFrames().pipe( 
        map(({timestamp})=>timestamp), //get timestamp
        pairwise(), //get previous timestamp
        map(([t0, t1]) => {
            const dt = Math.min(Constants.MAX_FRAMES, Math.max(0, t1 - t0));
            return { type: "TICK", dt, rand: hashRand(t1) } as Action;
        })//map to tick action

    );

    return merge(tick$, flap$, restart$).pipe( //merge all actions
        scan(reduceState, initial), //reduce state with each action
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const start$ = merge(
        fromEvent(document.body, "mousedown"),
        fromEvent<KeyboardEvent>(document, "keydown").pipe(filter(e => e.code === "Space"))
    ).pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            start$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
