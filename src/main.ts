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
    pairwise,
    tap,
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

// User input

type Key = "Space";

// State processing

type BirbState = Readonly <{
    y: number;
    vy: number;
}>;

// Ghost replay
type Ghost=Readonly<{t:number; y: number}>;
type Collision = "TOP" | "BOTTOM" // null if no collision

type Action =
    | {type:"FLAP"}
    | {type:"TICK"; dt: number; rand: number}
    | {type:"RESTART"};

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
    totalLives: ReadonlyArray<Lives>;
    lastHitTime: number;
    score: number;
    totalPipes: number;
    ghost: ReadonlyArray<Ghost>;
    track: ReadonlyArray<Ghost>;
}>;

const clamp =(
    x:number,
    low:number,
    high:number
) => Math.max(low, Math.min(high,x));

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

const initialState = (lives: Lives[]): State => { // start game
    const seedGapY = lives[0]?.gapY ?? 0.5; 
    const seedGapHeight = lives[0]?.gapHeight ?? 0.25; 

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
        birb: makeInitialBirb(),
        pipes: [seed],
        remainingLives:lives.slice(),
        lives: 3, // number of lives
        totalLives: lives.slice(), 
        lastHitTime: -Constants.COLLISION_COOLDOWN, // dont allow immediate collision
        score: 0,
        totalPipes: lives.length + 1, // +1 for the initial pipe
        ghost: [],
        track: [],
    };
};

const restartState = (prev: State): State => { //restart
  const ns = initialState(prev.totalLives as Lives[]);
  return { ...ns, ghost: prev.ghost };
};


// checks if the birb collides with pipes or boundaries
function checkCollision(b:BirbState, pipes: ReadonlyArray<Pipe>): Collision | null {
    if (b.y <= Constants.MARGIN) return "TOP";
    if (b.y + Birb.HEIGHT >= Viewport.CANVAS_HEIGHT - Constants.MARGIN) return "BOTTOM";

    for (const p of pipes) { // check each pipe
        const axisX = BIRB_X + Birb.WIDTH > p.x && BIRB_X < p.x + Constants.PIPE_WIDTH; // if the birb is within the x range of the pipe
        if (axisX) { // if within x range, check y range
            const gapTop = GapTop(p); // top of pipe gap
            const gapBottom = GapBottom(p); // bottom of gap
            const axisY = b.y > gapTop && b.y + Birb.HEIGHT < gapBottom; // if birb is within gap
            if (!axisY) { // if not within gap then collide
                return b.y <= gapTop ? "TOP" : "BOTTOM"; // which part of the pipe did the birb hit
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

    const toNum = (s:string, def:number) => { //str to num
        const n = Number(s);
        return isNaN(n) ? def : n;
    };

    const clamp02 = (x:number) => Math.max(0, Math.min(1,x)); //0 and 1

    const lives = lines.map(line => { // each line to a life
        const cols = line.split(",").map(s => s.trim()); // split by comma and trim
        const gapY = clamp02(toNum(cols[gapYIdx], 0.5)); // gap between 0 and 1, default 0.5
        const gapHeight = clamp02(toNum(cols[gapHeightIdx], 0.25));// gap height 0.25
        const at = Math.max(0, Math.round(toNum(cols[timeIdx], 0)*1000)); //time
        return { at, gapY, gapHeight} as Lives; 
    });

    return lives.sort((a,b) => a.at - b.at); //sort by time
}

function reduceState(s:State, a:Action): State{ 
    if (s.gameEnd) { //if the game is finished, stop
        return a.type === "RESTART" ? restartState(s) : s;
    }
    switch(a.type) { // used a switch statement to handle both flap and tick whichis the main actions
        case "FLAP": { //bird flying
            const velocityY=-Math.min( //up
                Constants.FLAP_RATE, // flap rate
                Constants.MAX_UP // max up speed
            );
            return{ ...s, birb: {...s.birb, vy:velocityY}}
        }
        case "TICK": {
            const dt = clamp(a.dt, 0, Constants.MAX_FRAMES); //delta time
            const time = s.time + dt; //time elapsed

            let remaining = s.remainingLives.slice(); // remaining lives
            let pipes = s.pipes.slice(); //pipes

            while (remaining.length > 0 && time >= remaining[0].at) { // add new pipe if time is right
                const sp = remaining[0]; // spawn new pipe
                remaining = remaining.slice(1); // remove from list of remaining lives
                pipes.push({ //new pipe to screen
                    id: nextPipe(pipes),
                    x: Viewport.CANVAS_WIDTH,
                    gapY: sp.gapY,
                    gapHeight: sp.gapHeight,
                    passed: false,
                });
            }

            const sec = dt / 1000; //seconds
            pipes = pipes //pipe movement
                .map( // move each pipe to the left
                    p => ({
                        ...p, // keep other properties the same
                        x: p.x-Constants.PIPE_SPEED*sec // move left
                    })
                )
                .filter(p => p.x + Constants.PIPE_WIDTH>0); // remove pipes that are off screen


            const vy_orig = s.birb.vy + Constants.GRAVITY_RATE*dt;//gravity effect
            const vy = clamp(// clamp the velocity of the birb
                vy_orig,
                -Constants.MAX_UP,
                Constants.MAX_DOWN
            );
            let y = clamp( //clamp the birb postion
                s.birb.y + vy*dt,
                0,
                Viewport.CANVAS_HEIGHT - Birb.HEIGHT
            );

            let score = s.score; //score logic setup

            pipes = pipes.map(p => { //passed the pip ?
            if (!p.passed && BIRB_X > p.x + Constants.PIPE_WIDTH) {
                const gapTop = GapTop(p); // top of pipe gap
                const gapBot = GapBottom(p); // bottom of gap
                const insideGapNow = (y >= gapTop) && (y + Birb.HEIGHT <= gapBot);
                if (insideGapNow) { // if the birb is within the gap
                score += 1; // increase score
                return { ...p, passed: true };
                }
            }
            return p;
            });

            let lives = s.lives; // lives logic setup
            let lastHitTime = s.lastHitTime; // last time hit
            let velocityY = vy; //velocity

            if (time - s.lastHitTime >= Constants.COLLISION_COOLDOWN) { //coll cooldown
                const hit = checkCollision({y, vy}, pipes); //check collision
                if (hit) { //hit something then:
                    lives = Math.max(0, s.lives - 1); //-life
                    lastHitTime = time; //update last hit time

                    const magnitude = a.rand * (Constants.BOUNCE_MAX - Constants.BOUNCE_MIN) + Constants.BOUNCE_MIN; // random bounce
                    velocityY = hit === "TOP" ? +magnitude : -magnitude; //bounce direction

                    y = clamp(y, 1, Viewport.CANVAS_HEIGHT - Birb.HEIGHT - 1); //keep birb in screen

                    velocityY = clamp( //clamp velocity after bounce
                        velocityY,
                        -Constants.MAX_UP,
                        Constants.MAX_DOWN
                    );
                }
            }
            const track = s.track.concat([{t: time, y}]); // add to track for ghost
            const willEnd = lives ===0 || (remaining.length ===0 && pipes.length ===0);
            const ghost = willEnd ? track : s.ghost; // if game will end, save the track as ghost

            return {
                ...s,
                time,
                birb: { y, vy: velocityY },
                pipes,
                remainingLives: remaining,
                lives,
                lastHitTime,
                score,
                gameEnd: willEnd,
                track: willEnd ? [] : track, // reset track if game will end
                ghost, //last run
            };
        }
        default:
            return s;
    }
}

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
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

const render = (): ((s: State) => void) => { //render game

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement; //screen

    svg.setAttribute( // set screen size
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    const namespace = svg.namespaceURI; //svg namespace

    let birbImg = svg.querySelector("#birbImg") as SVGElement; // birb image
    if (!birbImg) { //make birb if not exist
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

    // ghost sprite (once)
    let ghostImage = svg.querySelector("#ghostImage") as SVGImageElement | null;
    if (!ghostImage) {
        ghostImage = createSvgElement(svg.namespaceURI, "image", {
        id: "ghostImage",
        href: "assets/birb.png",
        x: String(BIRB_X),
        y: String(Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2),
        width: String(Birb.WIDTH),
        height: String(Birb.HEIGHT),
        }) as SVGImageElement;
        ghostImage.style.opacity = "0.35";
        ghostImage.style.filter = "grayscale(100%)";
        ghostImage.setAttribute("visibility", "hidden");
        svg.appendChild(ghostImage);
    }

    const pipeNodes = new Map<number, SVGGElement>();


    let livesText = document.querySelector("#livesText") as HTMLDivElement | null;
    if (!livesText) { //text for no of lives left
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
            display: "none"
        });
        document.body.appendChild(livesText);
    }

    let scoreText = document.getElementById("scoreText") as HTMLDivElement | null;
    if (!scoreText) { //text for score
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

        for (const p of s.pipes) { // for each pipe in the state
            current.add(p.id); // add to current set
            let g = pipeNodes.get(p.id); // get the pipe node if it exists
            if (!g) { //make new pipe node
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
        for (const [id, node] of pipeNodes) { //remove old pipes
                if (!current.has(id)) {
                    node.remove();
                    pipeNodes.delete(id);
                }
            }

        livesText!.textContent = `${s.lives}`; //update lives text
        if (s.gameEnd) { //game over text
            gameOver!.style.display = "flex"; 
            gameOver!.textContent = "Game Over! Play again.";
        } else{ // hide game over text
            gameOver!.style.display = "none";
        }
        scoreText!.textContent = `${s.score}`; //update score text

        const gs = s.ghost;
        if (gs.length === 0) {// no ghost
        ghostImage!.setAttribute("visibility", "hidden");
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
        bringToForeground(birbImg!);
    };
};

export const state$ = (csvContents: string): Observable<State> => { // main game observable
    /** User input */

    const key$ = fromEvent<KeyboardEvent>(document, "keydown");
    const lives = parseCSV(csvContents);
    const initial = initialState(lives);

    const flap$ = key$.pipe( // when space is pressed
        filter(e => e.code === "Space" && !e.repeat),
        map((): Action => ({ type: "FLAP" })) //calls flap action
    );

    const restart$ = merge( //restart game
        fromEvent(document, "mousedown"), // click to restart
        fromEvent<KeyboardEvent>(document, "keydown").pipe(filter(e => e.code === "Space")),
    ).pipe(map((): Action => ({ type: "RESTART" })));

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
