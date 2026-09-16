import type { Roadmap, RoadmapStep } from '../types'

/**
 * Mock AI-generated roadmaps, keyed by goal id.
 * In the AI version, `generateRoadmap` in services/aiService will
 * call the real model and produce this same shape.
 */

const webDevSteps: RoadmapStep[] = [
  {
    id: 'web-dev-1',
    title: 'HTML Foundations',
    description: 'Structure web pages with semantic elements, links and forms.',
    estimatedHours: 5,
    lessons: [
      {
        id: 'web-dev-1-1',
        title: 'How the Web Works',
        minutes: 10,
        content: `## What happens when you open a website?

Every website you visit is a set of **files** that live on a computer called a **server**. When you type a URL, your browser sends a *request*, and the server sends back a *response* containing the page.

- The **browser** is the client — it asks for pages.
- The **server** responds with HTML, CSS and JavaScript.
- HTML gives the page its **structure**, CSS its **style**, and JS its **behavior**.

### Why this matters
Before writing a single tag, you should picture the flow:

> Browser → request → server → response → rendered page

Understanding this loop will make debugging much easier later: network problems, broken links, and slow pages all live somewhere in this journey.`,
      },
      {
        id: 'web-dev-1-2',
        title: 'Semantic HTML Essentials',
        minutes: 15,
        content: `## Semantic HTML in 15 minutes

Semantic tags describe their **meaning**, not just their looks.

- \`<header>\` — top of the page, usually logo + navigation
- \`<nav>\` — a block of navigation links
- \`<main>\` — the unique main content of the page
- \`<section>\` — a thematic group of content
- \`<article>\` — self-contained content, like a blog post
- \`<footer>\` — bottom info like contacts and links

### Why not just use \`<div>\` everywhere?
1. **Accessibility** — screen readers navigate by landmarks.
2. **SEO** — search engines understand your structure better.
3. **Readability** — other developers (and future you) understand the layout instantly.

### Try it
Sketch the structure of your favorite news site using only semantic tags on paper. You will be surprised how clean it looks.`,
      },
      {
        id: 'web-dev-1-3',
        title: 'Forms and Inputs',
        minutes: 15,
        content: `## Forms: collecting input from users

A form wraps input controls and submits them somewhere.

- \`<form>\` — the container
- \`<input>\` — text, email, password, checkbox and more via \`type\`
- \`<label>\` — accessible label; always connect with \`for\`/\`id\`
- \`<button>\` — submits or performs an action

### Best practices
- Always pair a \`<label>\` with every input.
- Use the right \`type\` (e.g. \`type="email"\`) to get free validation and mobile keyboards.
- Group related controls with \`<fieldset>\` and \`<legend>\`.

> Forms are the first place real users interact with your app — get them right and everything after feels smoother.`,
      },
    ],
  },
  {
    id: 'web-dev-2',
    title: 'CSS & Responsive Layout',
    description: 'Style pages beautifully and make them work on every screen size.',
    estimatedHours: 7,
    lessons: [
      {
        id: 'web-dev-2-1',
        title: 'The Box Model & Selectors',
        minutes: 12,
        content: `## Everything is a box

Every element on the page is a rectangular box made of:

1. **content** — the text or image
2. **padding** — space *inside* the border
3. **border** — the edge line
4. **margin** — space *outside* the border

### Selectors you will use daily
- Type: \`p { }\`
- Class: \`.card { }\`
- ID: \`#hero { }\` (sparingly!)
- Combinators: \`.card p { }\`, \`.list > li { }\`

### A tip that saves hours
\`box-sizing: border-box\` makes width include padding and border — almost every modern stylesheet starts with it.`,
      },
      {
        id: 'web-dev-2-2',
        title: 'Flexbox and Grid',
        minutes: 18,
        content: `## Two layout superpowers

**Flexbox** arranges items in one direction (a row or a column). Perfect for navbars, button rows and card footers.

**Grid** arranges items in rows *and* columns at the same time. Perfect for page layouts and card galleries.

### Rules of thumb
- Choose **flexbox** when content should define the layout.
- Choose **grid** when the layout should define where content goes.

### Media queries make it responsive
\`@\`media queries let you apply different CSS at different screen widths — the backbone of responsive design:

\`\`\`
@media (max-width: 768px) { ... mobile styles ... }
\`\`\`

> Challenge: rebuild a simple two-column layout so it collapses to one column on mobile, using only flexbox/grid and one media query.`,
      },
    ],
  },
  {
    id: 'web-dev-3',
    title: 'JavaScript Fundamentals',
    description: 'Add behavior: variables, functions, arrays and the DOM.',
    estimatedHours: 8,
    lessons: [
      {
        id: 'web-dev-3-1',
        title: 'Variables, Types & Functions',
        minutes: 15,
        content: `## JavaScript gives pages a brain

- \`const\` — a value that will not be reassigned (use this most)
- \`let\` — a value that will change
- Types: string, number, boolean, null, undefined, object, array

### Functions package logic
\`function greet(name) { return 'Hi ' + name }\`

Arrow functions are the modern shorthand: \`const greet = (name) => 'Hi ' + name\`

### Think in small steps
Good JS is a chain of tiny, obvious functions — not one giant clever one. When stuck, describe the problem out loud in steps; that description *is* your code.`,
      },
      {
        id: 'web-dev-3-2',
        title: 'DOM & Events',
        minutes: 18,
        content: `## Making pages react

The **DOM** is the live tree of elements the browser builds from your HTML. JavaScript can read and change it:

- \`document.querySelector('.card')\` — grab an element
- \`el.textContent = 'New text'\` — change content
- \`el.classList.add('active')\` — change styling state
- \`el.addEventListener('click', handler)\` — react to user actions

### The mental model
User action → **event** → your **handler** → update **state** → update the **DOM**.

This exact loop powers every framework, including React — you are learning the foundation underneath it all.`,
      },
    ],
  },
  {
    id: 'web-dev-4',
    title: 'React Basics',
    description: 'Build component-driven interfaces with state and props.',
    estimatedHours: 9,
    lessons: [
      {
        id: 'web-dev-4-1',
        title: 'Components & Props',
        minutes: 16,
        content: `## React in one idea

A UI is a **function of data**. Describe the screen for any state, and React updates the page when the data changes.

- A **component** is a function that returns markup.
- **Props** are inputs passed from parent to child.
- Components compose like building blocks: small pieces → sections → pages.

### Design for reuse
If you copy-paste markup twice, extract a component. If you copy-paste a component's structure twice, extract a more general one with props.

This habit alone will make your projects feel twice as organized.`,
      },
      {
        id: 'web-dev-4-2',
        title: 'State & useEffect',
        minutes: 20,
        content: `## State: memory for your UI

\`const [count, setCount] = useState(0)\` gives a component memory. Changing state re-renders the UI automatically.

### useEffect: syncing with the outside world
Use effects for things *outside* React — timers, subscriptions, fetching:

\`useEffect(() => { ... }, [deps])\`

### The golden rule
Render your UI **from state**, never by mutating the DOM manually. Ask "what state fully describes this screen?" and the component almost writes itself.`,
      },
    ],
  },
  {
    id: 'web-dev-5',
    title: 'First Full Project',
    description: 'Combine everything into a responsive, interactive web app.',
    estimatedHours: 10,
    lessons: [
      {
        id: 'web-dev-5-1',
        title: 'Planning Your App',
        minutes: 12,
        content: `## Plan first, build second

Before writing code, answer four questions:

1. **Who** is the app for?
2. What are the 3 **core screens**?
3. What **state** does each screen need?
4. What **components** repeat across screens?

Write the answers down. A 30-minute plan prevents days of rework — professionals are not faster typists, they make fewer wrong turns.`,
      },
      {
        id: 'web-dev-5-2',
        title: 'Build, Break, Fix, Repeat',
        minutes: 18,
        content: `## The build loop

Work in this rhythm:

- **Build** one small feature at a time.
- **Break** it intentionally — what happens with empty input?
- **Fix** and move on. Never leave a broken state behind.

### Done means done
Your first project is finished when: it works on mobile, has no console errors, and a friend can use it without instructions.

> That is a portfolio-worthy achievement. Ship it.`,
      },
    ],
  },
]

const pythonSteps: RoadmapStep[] = [
  {
    id: 'python-1',
    title: 'Python Basics',
    description: 'Syntax, variables, loops and functions — your first scripts.',
    estimatedHours: 6,
    lessons: [
      {
        id: 'python-1-1',
        title: 'Your First Python Program',
        minutes: 12,
        content: `## Hello, Python

Python reads almost like English, which is why it is the most recommended first language.

- \`print('Hello')\` outputs text
- \`name = 'Asha'\` stores a value in a variable
- \`age = 17\` — no type declarations needed

### Why Python first
1. Minimal syntax noise — you focus on **logic**, not punctuation.
2. Huge community — every error you hit has been answered before.
3. It powers web backends, data science and AI — one language, many doors.

Run something tiny right now. Momentum beats theory.`,
      },
      {
        id: 'python-1-2',
        title: 'Lists, Loops & Logic',
        minutes: 15,
        content: `## Repeating work

- A **list** holds many values: \`scores = [90, 74, 88]\`
- A **for loop** visits each one: \`for s in scores:\`
- An **if statement** decides: \`if s > 85: print('Great')\`

### Think in data
Most programs are the same three moves: *collect data → transform data → output data*. Loops are the engine of all three.

Mini-challenge: print the average of a list without looking anything up — reasoning it out is the exercise.`,
      },
    ],
  },
  {
    id: 'python-2',
    title: 'Working with Data',
    description: 'Files, dictionaries and thinking in tables.',
    estimatedHours: 6,
    lessons: [
      {
        id: 'python-2-1',
        title: 'Dictionaries & Structured Data',
        minutes: 14,
        content: `## From values to records

A **dictionary** maps keys to values:

\`student = {'name': 'Asha', 'score': 91}\`

Now a list of dictionaries is a **table** — the shape of almost every real dataset.

### Why this shape matters
Databases, spreadsheets, APIs and pandas all speak this structure. Learn it once in plain Python and every data tool later feels familiar.`,
      },
    ],
  },
  {
    id: 'python-3',
    title: 'Mini Analysis Project',
    description: 'Load a real dataset, compute insights, tell the story.',
    estimatedHours: 8,
    lessons: [
      {
        id: 'python-3-1',
        title: 'Explore a Dataset',
        minutes: 18,
        content: `## Ask questions before coding

Data analysis is answering questions, not running commands:

1. What is the biggest value, and why?
2. What is the average, and what counts as "unusual"?
3. What trend would surprise you?

Compute the basics (max, min, mean), then look for the surprise. That surprise is your insight — and every insight you can explain clearly makes your work valuable.`,
      },
    ],
  },
]

const roadmapByGoal: Record<string, Roadmap> = {
  'web-dev': {
    id: 'rm-web-dev',
    goalId: 'web-dev',
    title: 'Web Development Roadmap',
    description: 'From empty folder to your first deployed web app.',
    createdAt: '2026-09-01',
    steps: webDevSteps,
  },
  'python-data': {
    id: 'rm-python',
    goalId: 'python-data',
    title: 'Python & Data Roadmap',
    description: 'From first script to your first data story.',
    createdAt: '2026-09-01',
    steps: pythonSteps,
  },
}

/**
 * In the AI version this will call the AI service to generate
 * a personalized roadmap; for now it returns mock data.
 */
export function getRoadmapForGoal(goalId: string): Roadmap | undefined {
  return roadmapByGoal[goalId]
}
