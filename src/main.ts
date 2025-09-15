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
    interval,
    map,
    scan,
    switchMap,
    take,
    animationFrames,
    merge,
    pairwise,
    takeWhile,
    pipe,
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
    COLLISION_COOLDOWN: 500,
    MARGIN: 5,
    BOUNCE_MIN: 0.25,
    BOUNCE_MAX: 0.75,
} as const;

// User input

type Key = "Space";

// State processing

type BirbState = Readonly <{
    y: number;
    vy: number;
}>;

type Collision = "TOP" | "BOTTOM" 

type Action =
    | {type:"FLAP"}
    | {type:"TICK"; dt: number}

type Lives = Readonly<{
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
    time: number;
    birb: BirbState;
    pipes: ReadonlyArray<Pipe>;
    remainingLives: ReadonlyArray<Lives>;
    lives: number;
    lastHitTime: number;
    score: number;
    totalPipes: number;
}>;

const clamp =(
    x:number,
    low:number,
    high:number
) => Math.max(low, Math.min(high,x));

const clamp02 = (x:number) => Math.max(0, Math.min(1,x));

const GapTop = (p:Pipe) =>
    p.gapY*Viewport.CANVAS_HEIGHT - (p.gapHeight*Viewport.CANVAS_HEIGHT)/2;

const GapBottom = (p:Pipe) =>
    p.gapY*Viewport.CANVAS_HEIGHT + (p.gapHeight*Viewport.CANVAS_HEIGHT)/2;

const nextPipe=(pipes:ReadonlyArray<Pipe>) =>
    pipes.reduce((acc, p) => Math.max(acc, p.id), -1)+1;

const makeInitialBirb=(): BirbState=> ({
    y: Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT/2,
    vy:0,
});

const initialState = (lives: Lives[]): State => {
    const seedGapY = lives[0]?.gapY ?? 0.5;
    const seedGapHeight = lives[0]?.gapHeight ?? 0.25;

    const seed: Pipe = {
        id: 0,
        x: Viewport.CANVAS_WIDTH - Constants.PIPE_WIDTH,
        gapY: seedGapY,
        gapHeight: seedGapHeight,
        passed: false,
    };

    return {
        gameEnd: false,
        time: 0,
        birb: makeInitialBirb(),
        pipes: [seed],
        remainingLives:lives.slice(),
        lives: 3,
        lastHitTime: -Constants.COLLISION_COOLDOWN,
        score: 0,
        totalPipes: lives.length + 1,
    };
};

function checkCollision(b:BirbState, pipes: ReadonlyArray<Pipe>): Collision | null {
    if (b.y <= Constants.MARGIN) return "TOP";
    if (b.y + Birb.HEIGHT >= Viewport.CANVAS_HEIGHT - Constants.MARGIN) return "BOTTOM";

    for (const p of pipes) {
        const axisX = BIRB_X + Birb.WIDTH > p.x && BIRB_X < p.x + Constants.PIPE_WIDTH;
        if (axisX) {
            const gapTop = GapTop(p);
            const gapBottom = GapBottom(p);
            const axisY = b.y > gapTop && b.y + Birb.HEIGHT < gapBottom;
            if (!axisY) {
                return b.y <= gapTop ? "TOP" : "BOTTOM";
            }
        }
    }
    return null;
}

function parseCSV (csv: string): Lives[] {
    const lines = csv.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    const headerLine = lines.shift() ?? "";
    const header = headerLine.split(",").map(s => s.trim());
    const gapYIdx = header.findIndex(h => h === "gap_y");
    const gapHeightIdx = header.findIndex(h => h === "gap_height");
    const timeIdx = header.findIndex(h => h === "time");

    const toNum = (s:string, def:number) => {
        const n = Number(s);
        return isNaN(n) ? def : n;
    };

    const clamp02 = (x:number) => Math.max(0, Math.min(1,x));

    const lives = lines.map(line => {
        const cols = line.split(",").map(s => s.trim());
        const gapY = clamp02(toNum(cols[gapYIdx], 0.5));
        const gapHeight = clamp02(toNum(cols[gapHeightIdx], 0.25));
        const at = Math.max(0, Math.round(toNum(cols[timeIdx], 0)*1000));
        return { at, gapY, gapHeight} as Lives;
    });

    return lives.sort((a,b) => a.at - b.at);
}

function reduceState(s:State, a:Action): State{
    switch(a.type) {
        case "FLAP": {
            const velocityY=-Math.min(
                Constants.FLAP_RATE,
                Constants.MAX_UP
            );
            return{ ...s, birb: {...s.birb, vy:velocityY}}
        }
        case "TICK": {
            const dt = clamp(a.dt, 0, Constants.MAX_FRAMES);
            const time = s.time + dt;

            let remaining = s.remainingLives.slice();
            let pipes = s.pipes.slice();

            while (remaining.length > 0 && time >= remaining[0].at) {
                const sp = remaining[0];
                remaining = remaining.slice(1);
                pipes.push({
                    id: nextPipe(pipes),
                    x: Viewport.CANVAS_WIDTH,
                    gapY: sp.gapY,
                    gapHeight: sp.gapHeight,
                    passed: false,
                });
            }

            const sec = dt / 1000;
            pipes = pipes
                .map(
                    p => ({
                        ...p,
                        x: p.x-Constants.PIPE_SPEED*sec
                    })
                )
                .filter(p => p.x + Constants.PIPE_WIDTH>0);


            const vy_orig = s.birb.vy + Constants.GRAVITY_RATE*dt;
            const vy = clamp(
                vy_orig,
                -Constants.MAX_UP,
                Constants.MAX_DOWN
            );
            let y = clamp(
                s.birb.y + vy*dt,
                0,
                Viewport.CANVAS_HEIGHT - Birb.HEIGHT
            );

            let score = s.score;

            pipes = pipes.map(p => {
            if (!p.passed && BIRB_X > p.x + Constants.PIPE_WIDTH) {
                const gapTop = GapTop(p);
                const gapBot = GapBottom(p);
                const insideGapNow = (y >= gapTop) && (y + Birb.HEIGHT <= gapBot);
                if (insideGapNow) {
                score += 1;
                return { ...p, passed: true };
                }
            }
            return p;
            });

            let lives = s.lives;
            let lastHitTime = s.lastHitTime;
            let velocityY = vy;

            if (time - s.lastHitTime >= Constants.COLLISION_COOLDOWN) {
                const hit = checkCollision({y, vy}, pipes);
                if (hit) {
                    lives = Math.max(0, s.lives - 1);
                    lastHitTime = time;

                    const magnitude = Math.random() * (Constants.BOUNCE_MAX - Constants.BOUNCE_MIN) + Constants.BOUNCE_MIN;
                    velocityY = hit === "TOP" ? +magnitude : -magnitude;

                    y = clamp(y, 1, Viewport.CANVAS_HEIGHT - Birb.HEIGHT - 1);

                    velocityY = clamp(
                        velocityY,
                        -Constants.MAX_UP,
                        Constants.MAX_DOWN
                    );
                }
            }

            return {
                ...s,
                time,
                birb: { y, vy: velocityY },
                pipes,
                remainingLives: remaining,
                lives,
                lastHitTime,
                score,
                gameEnd: lives === 0 || (remaining.length === 0 && pipes.length === 0),
            };
        }
        default:
            return s;
    }
}
/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State) => s;

// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
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

const render = (): ((s: State) => void) => {

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    const namespace = svg.namespaceURI;

    let birbImg = svg.querySelector("#birbImg") as SVGElement;
    if (!birbImg) {
        birbImg = createSvgElement(namespace, "image", {
            id: "birbImg",
            href: "assets/birb.png",
            x: `${BIRB_X}`,
            y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT/2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        }) as SVGElement;
        svg.appendChild(birbImg);
    }

    const pipeNodes = new Map<number, SVGGElement>();


    let livesText = document.querySelector("#livesText") as HTMLDivElement | null;
    if (!livesText) {
        livesText = document.createElement("div");
        livesText.id = "livesText";
        Object.assign(livesText.style, {
            position: "absolute",
            left: "10px",
            top: "10px",
            color: "white",
            fontSize: "20px",
            fontFamily: "Arial, sans-serif",
            textShadow: "2px 2px 4px #000000",
        });
        document.body.appendChild(livesText);
    }

    let scoreText = document.getElementById("scoreText") as HTMLDivElement | null;
    if (!scoreText) {
    scoreText = document.createElement("div");
    scoreText.id = "scoreText";
    Object.assign(scoreText.style, {
        position: "absolute",
        right: "12px",
        top: "8px",
        color: "white",
        font: "600 16px system-ui, sans-serif",
        textShadow: "0 1px 2px rgba(0,0,0,.6)",
    });
    document.body.appendChild(scoreText);
    }


    let gameOver = document.querySelector("#gameOver") as HTMLDivElement;
    if (!gameOver) {
        gameOver = document.createElement("div");
        gameOver.id = "gameOver";
        gameOver.innerText = "Game Over! Refresh to play again.";
        Object.assign(gameOver.style, {
            position: "absolute",
            justifyContent: "center",
            alignItems: "center",
            color: "red",
            fontSize: "40px",
            fontFamily: "Arial, sans-serif",
        });
        document.body.appendChild(gameOver);
    }

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

        const current = new Set<number>();

        for (const p of s.pipes) {
            current.add(p.id);
            let g = pipeNodes.get(p.id);
            if (!g) {
                g = document.createElementNS(namespace, "g") as SVGGElement;
                const top = createSvgElement(svg.namespaceURI, "rect");
                const bottom = createSvgElement(svg.namespaceURI, "rect");
                g.appendChild(top);
                g.appendChild(bottom);
                pipeNodes.set(p.id, g);
                svg.appendChild(g);
            }

            const gapTop= GapTop(p);
            const gapBottom= GapBottom(p);
            const [top, bottom] =Array.from(g.children) as [SVGRectElement, SVGRectElement];

            top.setAttribute("x", `${p.x}`);
            top.setAttribute("y", `0`);
            top.setAttribute("width", `${Constants.PIPE_WIDTH}`);
            top.setAttribute("height", `${gapTop}`);
            top.setAttribute("fill", "green");

            bottom.setAttribute("x", `${p.x}`);
            bottom.setAttribute("y", `${gapBottom}`);
            bottom.setAttribute("width", `${Constants.PIPE_WIDTH}`);
            bottom.setAttribute("height", `${Viewport.CANVAS_HEIGHT - gapBottom}`);
            bottom.setAttribute("fill", "green");

        };
        for (const [id, node] of pipeNodes) {
                if (!current.has(id)) {
                    node.remove();
                    pipeNodes.delete(id);
                }
            }

        bringToForeground(birbImg);
        livesText.textContent = `Lives: ${s.lives}`;
        gameOver.style.display = s.gameEnd ? "flex" : "none";
        scoreText!.textContent = `Score: ${s.score}`;
    };
};

export const state$ = (csvContents: string): Observable<State> => {
    /** User input */

    const key$ = fromEvent<KeyboardEvent>(document, "keydown");
    const lives = parseCSV(csvContents);
    const initial = initialState(lives);

    const flap$ = key$.pipe(
        filter(e => e.code === "Space" && !e.repeat),
        map((): Action => ({ type: "FLAP" }))
    );

    /** Determines the rate of time steps */
    const tick$ = animationFrames().pipe(
        map(({timestamp})=>timestamp),
        pairwise(),
        map(([t0, t1]) => ({type:"TICK", dt: Math.min(Constants.MAX_FRAMES, Math.max(0, t1-t0))}) as Action)
    );

    return merge(tick$, flap$).pipe(
        scan(reduceState, initial),
        takeWhile(s => !s.gameEnd, true) 
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
