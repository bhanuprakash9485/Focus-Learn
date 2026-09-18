import type { AiGeneratedRoadmap, AiRoadmapTopic, AiTopicStatus, Goal, Quiz, QuizDifficulty, QuizQuestion, Roadmap, User } from '../types'
import { goals as goalCatalog } from '../data/goals'
import { getRoadmapForGoal } from '../data/roadmaps'
import { apiUrl } from '../config/api'

/**
 * AI service boundary.
 *
 * Real Groq-backed functions (search, learning guides, tutor, roadmap
 * generation, quiz analysis) call the FastAPI backend at /api/ai/*.
 * The remaining local helpers (suggestGoals, generateRoadmap, the Focus
 * Mode quiz/tutor generator) are deterministic offline logic — used only
 * where no backend endpoint exists yet.
 */

/** Suggest goals matching a free-text interest (mock: keyword filter). */
export async function suggestGoals(query: string): Promise<Goal[]> {
  // TODO(ai): replace with real AI suggestion endpoint.
  const q = query.trim().toLowerCase()
  if (!q) return goalCatalog
  return goalCatalog.filter(
    (g) =>
      g.title.toLowerCase().includes(q) ||
      g.category.toLowerCase().includes(q) ||
      g.skills.some((s) => s.toLowerCase().includes(q)),
  )
}

/** Generate a personalized roadmap for a goal (mock: catalog lookup). */
export async function generateRoadmap(goal: Goal, _user: User): Promise<Roadmap | undefined> {
  // TODO(ai): call the model to personalize steps by user's level and time.
  void _user
  return getRoadmapForGoal(goal.id)
}

/* ------------------------------------------------------------------ */
/* "What Should I Study?" — mock recommendation engine                 */
/* ------------------------------------------------------------------ */

export interface StudyAdviceInput {
  goal: string
  level: 'Beginner' | 'Intermediate' | 'Advanced'
  timePerDay: string
  knowledge: 'I am starting from zero' | 'I know the basics' | 'I know intermediate concepts'
}

export interface StudyAdvice {
  /** Ordered learning path, e.g. "Step 1 — Programming Basics". */
  path: string[]
  /** The single topic to start with today. */
  nextTopic: string
  /** Why this topic is next (AI-style reasoning text). */
  reason: string
  /** Estimated weeks to finish the path at the chosen daily time. */
  estimatedWeeks: number
  /** Summary of how the inputs shaped the plan. */
  summary: string
}

/** Minutes per day implied by a "timePerDay" option label. */
function parseMinutesPerDay(timePerDay: string): number {
  if (timePerDay.startsWith('15')) return 15
  if (timePerDay.startsWith('30')) return 30
  if (timePerDay.startsWith('1 ')) return 60
  return 120
}

/**
 * "What Should I Study?" — real recommendation engine.
 * Delegates to the same Groq-backed roadmap generator used on the AI
 * Roadmap page and derives the study path and time estimate from the
 * returned phases. SafeSearch still guards the topic server-side.
 */
export async function getStudyAdvice(
  input: StudyAdviceInput,
): Promise<{ state: 'ready'; advice: StudyAdvice } | { state: 'error'; message: string }> {
  const topic = input.goal.trim()
  if (!topic) {
    return { state: 'error', message: 'Enter a learning goal first.' }
  }

  const result = await createRoadmap({
    topic,
    level: input.level.toLowerCase(),
    study_time: input.timePerDay,
    goal: input.knowledge,
  })
  if (result.state === 'error') {
    return {
      state: 'error',
      message: result.blocked
        ? 'This topic isn\'t available on FocusLearn.'
        : result.message,
    }
  }

  const roadmap = result.roadmap
  const path = roadmap.phases.flatMap((p) => p.topics.map((t) => t.title))
  const minutesPerDay = parseMinutesPerDay(input.timePerDay)
  const weeklyMinutes = minutesPerDay * 7
  const estimatedWeeks =
    roadmap.total_estimated_minutes > 0
      ? Math.max(1, Math.ceil(roadmap.total_estimated_minutes / weeklyMinutes))
      : Math.max(1, Math.ceil((path.length * 45) / minutesPerDay))

  return {
    state: 'ready',
    advice: {
      path,
      nextTopic: path[0] ?? roadmap.topic,
      reason: roadmap.overview || roadmap.final_goal,
      estimatedWeeks,
      summary:
        `Based on your ${input.level.toLowerCase()} level and ${input.timePerDay.toLowerCase()} per day, ` +
        `we mapped a ${roadmap.phases.length}-phase path (${path.length} topics) you can finish in about ${estimatedWeeks} week${estimatedWeeks > 1 ? 's' : ''}.`,
    },
  }
}

/* ------------------------------------------------------------------ */
/* AI Roadmap — adaptive learning (local, deterministic mock)          */
/* ------------------------------------------------------------------ */

/** Score at or above this percentage counts as topic mastery (80% = strong understanding). */
const MASTERY_THRESHOLD = 80

export interface TopicPerformance {
  /** The quiz score that was evaluated (0-100). */
  score: number
  /** True when the score meets the mastery threshold. */
  passed: boolean
  /** Student-facing message, e.g. the "needs review" nudge. */
  message: string
}

/**
 * Adaptive rule engine (mock AI): evaluates a topic quiz score and
 * decides whether the roadmap topic is mastered or should be flagged
 * as "Needs Review" so the student revisits it before continuing.
 * Local and deterministic — no external AI APIs are used. In the AI
 * version, attempt history goes to the model and this decision comes
 * back personalized.
 */
export function evaluateTopicPerformance(score: number): TopicPerformance {
  // TODO(ai): weigh attempt history, hesitation time and topic difficulty.
  if (score < MASTERY_THRESHOLD) {
    return {
      score,
      passed: false,
      message: 'Review recommended before continuing.',
    }
  }
  return {
    score,
    passed: true,
    message: 'Mastery reached — the topic is marked as Completed.',
  }
}

/**
 * Immutably apply an adaptive-learning decision to a roadmap topic.
 * A passed quiz marks the topic Completed; a failed one flags it
 * "Needs Review" with the reason stored in reviewNote.
 */
export function updateTopicStatus(
  topic: AiRoadmapTopic,
  status: AiTopicStatus,
  patch: Partial<Pick<AiRoadmapTopic, 'progress' | 'reviewNote'>> = {},
): AiRoadmapTopic {
  const next = { ...topic, ...patch, status }
  if (status === 'completed') delete next.reviewNote
  return next
}

/* ------------------------------------------------------------------ */
/* Focus Mode — topic-aware AI engine (local, deterministic mock)      */
/* ------------------------------------------------------------------ */

/** One message in the Focus Mode tutor conversation. */
export interface AssistantMessage {
  role: 'assistant' | 'user'
  text: string
}
/*                                                                     */
/* Everything below is the "AI" for the YouTube-powered Focus Mode.    */
/* It produces topic-specific summaries, tutor answers and quizzes     */
/* for ANY topic from a small local knowledge engine — no external     */
/* API required. Each exported function is a drop-in seam: swap the    */
/* body for a real model call and the UI code stays unchanged.         */
/* ------------------------------------------------------------------ */

/** Cleaned display form of a topic, e.g. "java inheritance" → "Java Inheritance". */
export function normalizeTopic(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'General'
  return cleaned
    .split(' ')
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(' ')
}

/** A canned answer style for the mock AI tutor. */
export interface TutorAnswer {
  kind:
    | 'explain-simply'
    | 'step-by-step'
    | 'example'
    | 'analogy'
    | 'code'
    | 'practice-question'
    | 'free-form'
  text: string
}

/** The generated lesson package shown on the Focus Mode right pane. */
export interface TopicLesson {
  topic: string
  summary: string
  keyPoints: string[]
  concepts: string[]
}

/** Specialized knowledge for topics we can describe precisely. */
interface TopicProfile {
  keywords: string[]
  subject: string
  /** What kind of thing the topic is, used in generated sentences. */
  kind: 'algorithm' | 'concept' | 'technology' | 'process'
  summary: string
  keyPoints: string[]
  concepts: string[]
  /** Exam-style terms students should be able to define. */
  terms: string[]
  analogy: string
  example: string
  code: string
}

/**
 * Hand-written profiles for common CS/programming topics. Anything that
 * does not match falls back to a generic (but still topic-specific)
 * template that weaves the topic name into every section.
 */
const topicProfiles: TopicProfile[] = [
  {
    keywords: ['binary search', 'searching'],
    subject: 'Binary search',
    kind: 'algorithm',
    summary:
      'Binary search is an efficient searching algorithm that works on sorted data by repeatedly ' +
      'dividing the search range into two halves. Each comparison with the middle element discards ' +
      'half of the remaining candidates, so even a million sorted items take at most about 20 steps.',
    keyPoints: [
      'Works only on sorted data — sort first if needed.',
      'Checks the middle element and compares it with the target.',
      'Eliminates half of the search space at every step.',
      'Time complexity: O(log n); space complexity: O(1) iterative.',
      'Compute mid as low + (high - low) / 2 to avoid integer overflow.',
      'Loop while low <= high so single-element windows are still checked.',
    ],
    concepts: ['Sorted array', 'Middle element', 'Search space', 'Time complexity', 'Two pointers (low/high)'],
    terms: [
      'Sorted array — data arranged in ascending/descending order, the precondition for binary search.',
      'Middle element — arr[mid], the value compared against the target each step.',
      'Low / High — pointers marking the current search window boundaries.',
      'Search space — the range [low, high] still containing a possible answer.',
      'O(log n) — logarithmic time: the window halves every step.',
      'Overflow-safe midpoint — low + (high - low) / 2.',
    ],
    analogy:
      'Think of finding a word in a dictionary: you open the middle, decide whether your word is ' +
      'before or after it, and throw away the impossible half. Repeat a few times and you land on ' +
      'the exact page — that is binary search.',
    example:
      'Search for 23 in [2, 5, 8, 12, 16, 23, 38, 56, 72, 91].\n' +
      'Step 1: low=0, high=9, mid=4 → 16 < 23 → go right.\n' +
      'Step 2: low=5, high=9, mid=7 → 56 > 23 → go left.\n' +
      'Step 3: low=5, high=6, mid=5 → 23 → found at index 5 in 3 comparisons.',
    code:
      'function binarySearch(arr, target) {\n' +
      '  let low = 0, high = arr.length - 1\n' +
      '  while (low <= high) {\n' +
      '    const mid = low + Math.floor((high - low) / 2)\n' +
      '    if (arr[mid] === target) return mid\n' +
      '    if (arr[mid] < target) low = mid + 1\n' +
      '    else high = mid - 1\n' +
      '  }\n' +
      '  return -1\n' +
      '}',
  },
  {
    keywords: ['inheritance', 'java inheritance', 'oop inheritance'],
    subject: 'Inheritance',
    kind: 'concept',
    summary:
      'Inheritance is an object-oriented principle where a child class acquires the fields and ' +
      'methods of a parent class. It models an "is-a" relationship, lets you reuse tested code, ' +
      'and enables polymorphism — one reference type, many runtime behaviors.',
    keyPoints: [
      'The child (subclass) extends the parent (superclass) and inherits its members.',
      'Constructors are not inherited; the child calls super(...) to initialize the parent part.',
      'Method overriding redefines an inherited method with the same signature.',
      'Java supports single inheritance of classes; interfaces allow multiple inheritance of type.',
      '"is-a" vs "has-a": inherit for is-a relationships, compose for has-a.',
      'final classes cannot be extended; private members are inherited but not directly accessible.',
    ],
    concepts: ['Class', 'Superclass / subclass', 'extends keyword', 'Method overriding', 'Polymorphism', 'super'],
    terms: [
      'Superclass (parent) — the class whose members are inherited.',
      'Subclass (child) — the class that extends the parent and adds behavior.',
      'extends — Java keyword establishing the inheritance relationship.',
      'Method overriding — redefining an inherited method with the same signature.',
      'super — reference to the parent part used to call its constructor/methods.',
      'Polymorphism — one parent-type reference, many runtime behaviors.',
    ],
    analogy:
      'A vehicle blueprint defines wheels and an engine; "Car" and "Motorcycle" blueprints inherit ' +
      'all of that and only add what makes them different. Nobody rewrites the wheel.',
    example:
      'class Vehicle { void start() { print("Engine on") } }\n' +
      'class Car extends Vehicle { }\n' +
      'Car c = new Car(); c.start(); // prints "Engine on" — inherited from Vehicle',
    code:
      'class Animal {\n' +
      '  void speak() { System.out.println("Some sound"); }\n' +
      '}\n' +
      'class Dog extends Animal {\n' +
      '  @Override void speak() { System.out.println("Woof!"); }\n' +
      '}\n' +
      'Animal a = new Dog(); // polymorphism\n' +
      'a.speak(); // "Woof!"',
  },
  {
    keywords: ['python loop', 'loops', 'for loop', 'while loop', 'iteration'],
    subject: 'Loops',
    kind: 'concept',
    summary:
      'Loops repeat a block of code until a condition changes. In Python, for-loops iterate over ' +
      'sequences item by item, while while-loops run as long as a condition stays true. Choosing ' +
      'the right loop keeps code short, readable and free of repeated copy-paste blocks.',
    keyPoints: [
      'for loops iterate over any iterable: lists, strings, ranges, dictionaries.',
      'while loops repeat until their condition becomes false — beware infinite loops.',
      'range(start, stop, step) generates index sequences for counted repetition.',
      'break exits the loop early; continue skips to the next iteration.',
      'enumerate() gives both index and value; zip() walks two lists together.',
      'Loop variables exist after the loop ends — a common source of subtle bugs.',
    ],
    concepts: ['Iteration', 'Iterable', 'range()', 'break / continue', 'Loop condition'],
    terms: [
      'Iteration — one pass of the loop body.',
      'Iterable — any object a for-loop can walk over (list, string, range).',
      'range(start, stop, step) — generates counted sequences.',
      'break — exits the loop immediately.',
      'continue — skips to the next iteration.',
      'Infinite loop — a while-condition that never becomes false.',
    ],
    analogy:
      'A loop is like walking a shopping list: for each item on the list (iteration), you grab it ' +
      'from the shelf (body), and you stop when the list ends or you find what you needed (break).',
    example:
      'for score in [90, 74, 88]:\n    print(score)\n' +
      'Prints 90, then 74, then 88 — one iteration per list element.',
    code:
      'total = 0\n' +
      'for n in range(1, 6):   # 1,2,3,4,5\n' +
      '    total += n\n' +
      'print(total)  # 15',
  },
  {
    keywords: ['operating system', 'os scheduling', 'scheduling', 'cpu scheduling', 'process'],
    subject: 'Operating system scheduling',
    kind: 'process',
    summary:
      'OS scheduling decides which ready process or thread gets the CPU next. Because there are ' +
      'usually more runnable tasks than cores, the scheduler trades off fairness, throughput, ' +
      'latency and starvation using policies like FCFS, SJF, Round Robin and Priority.',
    keyPoints: [
      'FCFS is simple and fair in arrival order but suffers from the convoy effect.',
      'SJF/SRTF minimizes average waiting time but needs burst-time predictions.',
      'Round Robin gives each process a fixed time quantum — great for interactivity.',
      'Priority scheduling can starve low-priority tasks; aging fixes it.',
      'Context switches save/restore state and add overhead between quanta.',
      'Metrics to know: waiting time, turnaround time, response time, throughput.',
    ],
    concepts: ['Process states', 'Time quantum', 'Context switch', 'Starvation & aging', 'Gantt chart', 'FCFS / SJF / RR'],
    terms: [
      'FCFS — first-come, first-served scheduling in arrival order.',
      'SJF — shortest job first; minimizes average waiting time.',
      'Round Robin — fixed time quantum per process, cyclic.',
      'Time quantum — the slice a process gets before preemption.',
      'Context switch — saving/restoring state between processes.',
      'Starvation & aging — indefinite waiting and its fix.',
    ],
    analogy:
      'One cashier, many customers: serve whoever arrived first (FCFS), serve the quickest first ' +
      '(SJF), or give each person 2 minutes and rotate (Round Robin). Each rule changes who waits.',
    example:
      'Processes P1(5ms), P2(2ms), P3(8ms) with Round Robin q=2:\n' +
      'P1 P1 P2 P2 P3 P3 P3 P3 P1 P1 P1 → waiting times: P1=8, P2=4, P3=6 (avg 6ms).',
    code:
      '// Round Robin core idea\n' +
      'while (queue not empty) {\n' +
      '  p = queue.popFront()\n' +
      '  run(p, min(QUANTUM, p.remaining))\n' +
      '  if (p.remaining > 0) queue.pushBack(p)\n' +
      '}',
  },
  {
    keywords: ['normalization', 'dbms normalization', 'database normalization', '1nf', '2nf', '3nf', 'dbms'],
    subject: 'DBMS normalization',
    kind: 'process',
    summary:
      'Normalization organizes database tables to remove redundancy and update anomalies by ' +
      'decomposing them through normal forms: 1NF (atomic values), 2NF (no partial dependency), ' +
      '3NF (no transitive dependency), up to BCNF. Well-normalized schemas stay consistent as data grows.',
    keyPoints: [
      '1NF: every column holds atomic values, no repeating groups.',
      '2NF: be in 1NF and every non-key column depends on the whole primary key.',
      '3NF: be in 2NF and non-key columns depend only on the key (no transitive chains).',
      'BCNF: every determinant is a candidate key — the strict common form.',
      'Normalization reduces redundancy but too much decomposition adds join cost.',
      'Anomalies prevented: insertion, update and deletion anomalies.',
    ],
    concepts: ['Functional dependency', 'Primary key', 'Partial dependency', 'Transitive dependency', 'Normal forms (1NF–BCNF)'],
    terms: [
      'Functional dependency — one attribute determines another.',
      '1NF — atomic column values, no repeating groups.',
      '2NF — 1NF plus no partial dependency on a composite key.',
      '3NF — 2NF plus no transitive dependencies.',
      'BCNF — every determinant is a candidate key.',
      'Update anomaly — data inconsistency from redundant copies.',
    ],
    analogy:
      'Instead of writing your address on every library form you fill, the office keeps one address ' +
      'card and references it — change it once and every form is up to date. That is normalization.',
    example:
      'Unnormalized: student(roll, name, dept, deptHod)\n' +
      '3NF: student(roll, name, dept) + department(dept, deptHod)\n' +
      'Now renaming a HOD updates exactly one row.',
    code:
      '-- 3NF decomposition\n' +
      'CREATE TABLE student (roll INT PRIMARY KEY, name TEXT, dept_id INT REFERENCES department(id));\n' +
      'CREATE TABLE department (id INT PRIMARY KEY, hod_name TEXT);',
  },
  {
    keywords: ['computer network', 'networking', 'osi', 'tcp', 'ip model'],
    subject: 'Computer networks',
    kind: 'concept',
    summary:
      'Computer networks let devices exchange data through layered protocols. The OSI model ' +
      'separates concerns across 7 layers while TCP/IP compresses them into 4 that actually run ' +
      'the internet — links, internet, transport and application.',
    keyPoints: [
      'OSI layers: Physical, Data Link, Network, Transport, Session, Presentation, Application.',
      'TCP is reliable and connection-oriented; UDP is fast and connectionless.',
      'IP addressing and routing belong to the network layer; MAC to the data link layer.',
      'Three-way handshake (SYN, SYN-ACK, ACK) establishes a TCP connection.',
      'DNS resolves names to IPs before most connections start.',
      'Switches forward by MAC (L2), routers by IP (L3).',
    ],
    concepts: ['OSI model', 'TCP vs UDP', 'IP addressing', 'Packet switching', 'Three-way handshake', 'DNS'],
    terms: [
      'OSI model — 7-layer reference model for network communication.',
      'TCP — reliable, connection-oriented transport.',
      'UDP — fast, connectionless transport.',
      'IP address — logical layer-3 address used for routing.',
      'Three-way handshake — SYN → SYN-ACK → ACK connection setup.',
      'DNS — resolves domain names to IP addresses.',
    ],
    analogy:
      'Sending a parcel: the application writes the letter (payload), transport decides tracked ' +
      '(TCP) or cheap-and-fast (UDP), network layer reads the address (IP) to pick each hop.',
    example:
      'Loading a website: DNS lookup → TCP handshake with the server → HTTP GET request → ' +
      'response packets reassembled by TCP → browser renders the page.',
    code:
      '$ ping example.com        # tests reachability (ICMP)\n' +
      '$ nslookup example.com    # DNS resolution\n' +
      '$ curl -v https://example.com  # full HTTP over TCP exchange',
  },
  {
    keywords: ['machine learning', 'ml', 'supervised', 'unsupervised', 'neural network', 'ai model'],
    subject: 'Machine learning',
    kind: 'concept',
    summary:
      'Machine learning builds programs that improve from data instead of explicit rules. In ' +
      'supervised learning the model trains on labeled examples to predict outputs; unsupervised ' +
      'learning finds structure in unlabeled data; reinforcement learning optimizes actions via reward.',
    keyPoints: [
      'Supervised: regression (continuous output) and classification (discrete labels).',
      'Unsupervised: clustering (k-means) and dimensionality reduction (PCA).',
      'Split data into train/validation/test to measure real generalization.',
      'Loss functions quantify error; optimizers like gradient descent minimize them.',
      'Overfitting = memorizing training data; fight it with regularization and more data.',
      'Feature quality often matters more than model complexity.',
    ],
    concepts: ['Training data', 'Features & labels', 'Loss function', 'Overfitting', 'Gradient descent', 'Train/test split'],
    terms: [
      'Features — input variables the model learns from.',
      'Labels — the outputs to predict in supervised learning.',
      'Loss function — measures prediction error to minimize.',
      'Overfitting — memorizing training data, failing on new data.',
      'Gradient descent — optimizer stepping against the loss gradient.',
      'Train/test split — separating data to measure generalization.',
    ],
    analogy:
      'Teaching with flashcards: show the question (features) and the answer (label) hundreds of ' +
      'times, then quiz on new cards. If a student only memorizes the exact cards, they fail the quiz — overfitting.',
    example:
      'House prices: given size and location (features), a regression model predicts price ' +
      '(label). Trained on 1,000 past sales, it generalizes to a new house it has never seen.',
    code:
      'from sklearn.linear_model import LinearRegression\n' +
      'model = LinearRegression().fit(X_train, y_train)\n' +
      'preds = model.predict(X_test)  # evaluate on unseen data',
  },
  {
    keywords: ['quantum computing', 'qubit', 'superposition', 'quantum'],
    subject: 'Quantum computing',
    kind: 'technology',
    summary:
      'Quantum computing processes information with qubits, which exploit superposition and ' +
      'entanglement to explore many states at once. Certain problems — factoring, unstructured ' +
      'search, quantum simulation — see exponential speedups over classical machines.',
    keyPoints: [
      'A qubit holds a superposition of |0⟩ and |1⟩ until measured.',
      'Measurement collapses the state to a classical 0 or 1 probabilistically.',
      'Entanglement links qubits so their outcomes are correlated.',
      'Superposition alone is not speedup — interference is what amplifies right answers.',
      'Shor factors integers in polynomial time; Grover searches in O(√n).',
      'Decoherence and noise are the central engineering challenges today.',
    ],
    concepts: ['Qubit', 'Superposition', 'Entanglement', 'Measurement', 'Interference', 'Decoherence'],
    terms: [
      'Qubit — quantum bit holding a superposition of |0⟩ and |1⟩.',
      'Superposition — being in a combination of states until measured.',
      'Entanglement — correlated quantum states across qubits.',
      'Measurement — collapses superposition to a classical outcome.',
      'Interference — amplifying right answers, cancelling wrong ones.',
      'Decoherence — loss of quantum state through environmental noise.',
    ],
    analogy:
      'A classical coin is heads or tails; a spinning coin is "both until it lands" (superposition). ' +
      'Two coins spun together so their landings always match are entangled.',
    example:
      'Grover on a 1,000-item unstructured list: ~√1000 ≈ 32 quantum steps versus ~500 classical ' +
      'checks on average — a quadratic speedup from amplifying the marked state.',
    code:
      '# Qiskit: put one qubit into superposition\n' +
      'qc = QuantumCircuit(1, 1)\n' +
      'qc.h(0)          # Hadamard: |0> -> (|0>+|1>)/sqrt(2)\n' +
      'qc.measure(0, 0) # ~50/50 outcome',
  },
  {
    keywords: ['html form', 'forms', 'html', 'form element'],
    subject: 'HTML forms',
    kind: 'technology',
    summary:
      'HTML forms collect user input and send it to a server. The <form> element wraps inputs, ' +
      'defines the submission method (GET/POST) and target, while input types, labels and ' +
      'validation attributes control what the user can enter and how accessible it is.',
    keyPoints: [
      '<form action="/submit" method="post"> defines where and how data goes.',
      'Every input needs name=value pairs — no name means the field is not submitted.',
      'Input types (email, number, date, password) trigger validation and mobile keyboards.',
      '<label for> ties text to inputs — essential for accessibility and click targets.',
      'required, minlength, pattern give free client-side validation.',
      'GET puts data in the URL; POST sends it in the body — use POST for sensitive data.',
    ],
    concepts: ['<form> element', 'Input types', 'name attribute', 'Label & accessibility', 'Client-side validation', 'GET vs POST'],
    terms: [
      '<form> — wraps inputs and defines action/method.',
      'name attribute — the key the field value is submitted under.',
      'Input type — email/number/date etc.; controls validation + keyboard.',
      '<label for> — accessible text tied to an input.',
      'required / pattern — declarative client-side validation.',
      'GET vs POST — URL query vs request-body submission.',
    ],
    analogy:
      'A paper form at a clinic: printed headings are labels, blank boxes are inputs, and the ' +
      'receptionist filing it is the form action submitting data where it belongs.',
    example:
      'A login form: <input type="email" name="email" required> and ' +
      '<input type="password" name="pass"> — the browser validates the email format before anything is sent.',
    code:
      '<form action="/signup" method="post">\n' +
      '  <label for="em">Email</label>\n' +
      '  <input id="em" name="email" type="email" required>\n' +
      '  <button>Create account</button>\n' +
      '</form>',
  },
]

/** Normalize a topic string to a comparable lowercase keyword haystack. */
function topicHaystack(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Important terms for a topic (mock AI). Falls back to generated
 * definitions for topics without a hand-written profile.
 * TODO(ai): model-extracted glossary per topic.
 */
export function getImportantTerms(topic: string): string[] {
  const profile = findProfile(topic)
  if (profile) return profile.terms
  const t = normalizeTopic(topic)
  return [
    `${t} — the core idea this lesson teaches; be able to define it in one sentence.`,
    'Key terminology — the special words used when discussing the topic.',
    'Process — the standard steps for applying the topic correctly.',
    'Use case — a realistic situation where the topic is the right tool.',
    'Common pitfall — the mistake students most often make with it.',
  ]
}

/** Find the best-matching profile for a topic, or null to use the generic template. */
function findProfile(topic: string): TopicProfile | null {
  const hay = topicHaystack(topic)
  let best: { profile: TopicProfile; score: number } | null = null
  for (const profile of topicProfiles) {
    for (const kw of profile.keywords) {
      if (hay.includes(kw)) {
        const score = kw.length
        if (!best || score > best.score) best = { profile, score }
      }
    }
  }
  return best?.profile ?? null
}

/**
 * Topic lesson generator (mock AI). Uses a hand-written profile for
 * well-known topics and an intelligent generic template for anything
 * else, always weaving the specific topic into the content.
 * TODO(ai): replace with one model call returning the same TopicLesson shape.
 */
export function generateVideoSummary(
  topic: string,
  _videoTitle?: string,
  _description?: string,
): TopicLesson {
  void _videoTitle
  void _description
  const t = normalizeTopic(topic)
  const profile = findProfile(topic)
  if (profile) {
    return { topic: t, summary: profile.summary, keyPoints: profile.keyPoints, concepts: profile.concepts }
  }

  // Generic fallback that is still topic-specific.
  return {
    topic: t,
    summary:
      `${t} is an important topic in this subject area, and this lesson builds your understanding ` +
      `from the ground up: what ${t} means, the key ideas behind it, where it is used in practice, ` +
      `and the typical questions asked about it in exams and interviews.`,
    keyPoints: [
      `Core definition: what exactly ${t} is and the problem it solves.`,
      `The main components or rules that make up ${t}.`,
      `How ${t} works step by step in the most common case.`,
      `Real-world situations where ${t} is applied.`,
      `Common mistakes and misconceptions students make with ${t}.`,
      `How ${t} connects to neighbouring topics you will study next.`,
    ],
    concepts: [`Definition of ${t}`, 'Key terminology', 'Step-by-step process', 'Use cases', 'Common pitfalls'],
  }
}

/** Preset styles the Focus Mode tutor can answer with. */
export interface TutorPreset {
  label: string
  kind: TutorAnswer['kind']
}

/** The six preset buttons shown under the AI Tutor. */
export const TUTOR_PRESETS: TutorPreset[] = [
  { label: 'Explain Simply', kind: 'explain-simply' },
  { label: 'Explain Step-by-Step', kind: 'step-by-step' },
  { label: 'Give Example', kind: 'example' },
 { label: 'Give Analogy', kind: 'analogy' },
  { label: 'Show Code', kind: 'code' },
  { label: 'Practice Question', kind: 'practice-question' },
]

/** Build a practice question for a topic (used by mock tutor + quiz). */
function buildPracticeQuestion(topic: string, profile: TopicProfile | null, index: number): {
  prompt: string
  options: string[]
  correctIndex: number
  explanation: string
  concept: string
} {
  const t = normalizeTopic(topic)
  if (profile) {
    const subject = profile.subject
    const pool: { prompt: string; options: string[]; correctIndex: number; explanation: string; concept: string }[] = [
      {
        prompt: `Which statement best describes ${subject}?`,
        options: [
          `A technique that is unrelated to ${subject}`,
          `${profile.keyPoints[0]}`,
          `${profile.keyPoints[1]}`,
          'None of these',
        ],
        correctIndex: 1,
        explanation: profile.keyPoints[0],
        concept: profile.concepts[0] || subject,
      },
      {
        prompt: `What is the most important idea behind ${subject}?`,
        options: [profile.keyPoints[2], profile.keyPoints[3], profile.keyPoints[1], 'Memorizing syntax'],
        correctIndex: 0,
        explanation: profile.keyPoints[2],
        concept: profile.concepts[1] || subject,
      },
      {
        prompt: `Which of these is a core concept of ${subject}?`,
        options: [
          profile.concepts[0],
          profile.concepts[1],
          profile.concepts[2],
          'All of the above',
        ],
        correctIndex: 3,
        explanation: `All listed items are core concepts of ${subject}.`,
        concept: profile.concepts[2] || subject,
      },
    ]
    return pool[index % pool.length]
  }
  const generic: { prompt: string; options: string[]; correctIndex: number; explanation: string; concept: string }[] = [
    {
      prompt: `What is the first thing to understand about ${t}?`,
      options: [
        'Memorizing every formula',
        `What ${t} means and the problem it solves`,
        'Skipping to advanced cases',
        'None of these',
      ],
      correctIndex: 1,
      explanation: `Understanding the definition and purpose of ${t} comes first.`,
      concept: `${t} Fundamentals`,
    },
    {
      prompt: `Where is ${t} most commonly applied?`,
      options: [
        'In real problems that involve ' + t.toLowerCase(),
        'Only in textbooks',
        'Nowhere in practice',
        'Only in one niche industry',
      ],
      correctIndex: 0,
      explanation: `${t} is applied in real problems involving ${t.toLowerCase()}.`,
      concept: `${t} Applications`,
    },
    {
      prompt: `What is a common mistake when learning ${t}?`,
      options: [
        'Practising with examples',
        'Explaining it aloud',
        'Skipping the fundamentals and jumping to edge cases',
        'Asking questions',
      ],
      correctIndex: 2,
      explanation: `Fundamentals first: edge cases of ${t} only make sense once the basics are solid.`,
      concept: `${t} Best Practices`,
    },
  ]
  return generic[index % generic.length]
}

/**
 * Topic quiz generator (mock AI). Produces a Quiz-shaped object for ANY
 * topic so "Take Quiz" in Focus Mode always has matching content.
 * TODO(ai): replace with a model call that writes questions per topic.
 */
export function getTopicQuiz(topic: string): Quiz {
  const t = normalizeTopic(topic)
  const profile = findProfile(topic)
  const q1 = buildPracticeQuestion(topic, profile, 0)
  const q2 = buildPracticeQuestion(topic, profile, 1)
  const q3 = buildPracticeQuestion(topic, profile, 2)
  return {
    id: `quiz-topic-${topicHaystack(t).replace(/\s/g, '-')}`,
    lessonId: `topic-${topicHaystack(t).replace(/\s/g, '-')}`,
    title: `${t} — Check`,
    questions: [
      { id: 'q1', prompt: q1.prompt, options: q1.options, correctIndex: q1.correctIndex, explanation: q1.explanation, concept: q1.concept },
      { id: 'q2', prompt: q2.prompt, options: q2.options, correctIndex: q2.correctIndex, explanation: q2.explanation, concept: q2.concept },
      { id: 'q3', prompt: q3.prompt, options: q3.options, correctIndex: q3.correctIndex, explanation: q3.explanation, concept: q3.concept },
    ],
  }
}

/**
 * AI tutor for Focus Mode (mock). Answers are always related to the
 * currently selected topic: preset kinds use the topic profile, and
 * free-form questions are matched by keyword before falling back to a
 * topic-aware generic explanation.
 * TODO(ai): replace with a model call using (topic, question) as prompt context.
 */
export async function askTutor(topic: string, question: string, kind?: TutorAnswer['kind']): Promise<string> {
  const t = normalizeTopic(topic)
  const profile = findProfile(topic)
  await new Promise((r) => setTimeout(r, 550)) // simulate thinking time

  const q = question.toLowerCase()
  const kindOrMatched: TutorAnswer['kind'] =
    kind ??
    (/(simple|easy|eli5|beginner)/.test(q)
      ? 'explain-simply'
      : /(step|stages|order)/.test(q)
        ? 'step-by-step'
        : /(example|sample|demonstrate|walk)/.test(q)
          ? 'example'
          : /(analogy|metaphor|compare|like)/.test(q)
            ? 'analogy'
            : /(code|program|implement|syntax|write)/.test(q)
              ? 'code'
              : /(practice|question|exercise|quiz|test)/.test(q)
                ? 'practice-question'
                : 'free-form')

  if (profile) {
    const s = profile.subject
    switch (kindOrMatched) {
      case 'explain-simply':
        return `${s} in one line: ${profile.keyPoints[0].charAt(0).toLowerCase() + profile.keyPoints[0].slice(1)} ` +
          `In plain words — ${profile.analogy}`
      case 'step-by-step':
        return profile.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')
      case 'example':
        return profile.example
      case 'analogy':
        return profile.analogy
      case 'code':
        return profile.code
      case 'practice-question':
        return buildPracticeQuestion(topic, profile, 0).prompt
      case 'free-form':
        return `Good question about ${s}. Here is the core of it: ${profile.keyPoints[1]} ` +
          `A common point of confusion is mixing this up with neighbouring ideas — keep ${profile.concepts[0].toLowerCase()} ` +
          `and ${profile.concepts[1]?.toLowerCase() ?? 'the key terms'} separate in your notes, and the rest follows.`
    }
  }

  switch (kindOrMatched) {
    case 'explain-simply':
      return `Think of ${t} as a toolbox solution: it exists because a certain problem keeps coming ` +
        `up, and this is the standard, well-tested way to solve it. Master the simple case first — ` +
        `everything else is variation.`
    case 'step-by-step':
      return `A study path for ${t}:\n` +
        `1. Learn the definition and why ${t} exists.\n` +
        `2. Break it into its main parts or rules.\n` +
        `3. Work through one small example end to end.\n` +
        `4. Try a slightly harder variation on your own.\n` +
        `5. Explain it aloud from memory to lock it in.`
    case 'example':
      return `Here is how ${t} shows up in practice: start from ` +
        `the smallest realistic scenario, apply the standard process for ${t} step by step, write down ` +
        `each intermediate result, and check the final answer against what you expected.`
    case 'analogy':
      return `Learning ${t} is like learning a route across a city: the first walk feels random, but ` +
        `once you know the landmarks (the key ideas of ${t}), every later trip is just connecting ` +
        `places you already know.`
    case 'code':
      return `# Practice scaffold for ${t}\n` +
        `1. Write the definition in your own words.\n` +
        `2. Work one minimal example end to end.\n` +
        `3. Note the two most common exam twists.\n` +
        `4. Explain it aloud without notes — if you stumble, revisit step 1.`
    case 'practice-question':
      return `Practice question on ${t}: ${buildPracticeQuestion(topic, null, 1).prompt}`
    case 'free-form':
      return `Good question about ${t}. The heart of it: ${t} exists to solve a specific, recurring ` +
        `problem — once you can state that problem clearly, the rules and steps of ${t} stop being ` +
        `memorization and start being obvious. Try asking for an example or step-by-step view next.`
  }
}

/* ------------------------------------------------------------------ */
/* Spec'd AI API — the four functions the Focus Mode UI consumes.      */
/* Each is mock/local today and designed as a drop-in seam for a real  */
/* AI API later. No gateway, no API key, nothing exposed client-side.  */
/* ------------------------------------------------------------------ */

/**
 * generateSummary — mock AI summary for ANY topic/video.
 * Signature matches the spec: (topic, videoTitle, videoDescription?).
 * Thin alias over the topic lesson generator + important terms.
 * TODO(ai): one model call returning the same TopicLesson shape.
 */
export async function generateSummary(
  topic: string,
  videoTitle?: string,
  videoDescription?: string,
): Promise<TopicLesson & { terms: string[] }> {
  await new Promise((r) => setTimeout(r, 700)) // simulate AI latency
  const lesson = generateVideoSummary(topic, videoTitle, videoDescription)
  return { ...lesson, terms: getImportantTerms(topic) }
}

/**
 * generateQuiz — mock quiz for ANY topic. Alias of getTopicQuiz with the
 * spec'd name so the UI reads `generateQuiz(currentTopic)`.
 * TODO(ai): model-generated questions per topic.
 */
export async function generateQuiz(topic: string): Promise<Quiz> {
  await new Promise((r) => setTimeout(r, 350))
  return getTopicQuiz(topic)
}

/**
 * generateRecommendation — mock next-step advice for a topic, scaled by
 * the student's quiz performance. Used on the Focus Mode right pane.
 * TODO(ai): model-personalized study coaching.
 */
export async function generateRecommendation(
  topic: string,
  performance: { score: number } | null,
): Promise<string> {
  await new Promise((r) => setTimeout(r, 300))
  const t = normalizeTopic(topic)
  if (!performance) {
    return `Watch the lesson, then take the ${t} quiz — your next step will be ` +
      `personalized based on how you do.`
  }
  if (performance.score >= 70) {
    return `Strong ${t} understanding. Move to a related advanced topic, or revisit ` +
      `this lesson's code example once before moving on.`
  }
  return `${t} needs another pass. Rewatch the middle of the video, use the tutor's ` +
    `step-by-step view, then retake the quiz.`
}

/** Exposed for the Focus Mode summary / key points / concepts cards. */
export function getLessonKnowledge(): TopicLesson & { terms: string[] } {
  return { ...generateVideoSummary('binary search'), terms: getImportantTerms('binary search') }
}

/* ------------------------------------------------------------------ */
/* AI Learning Guide — real Groq-backed guide (Learn Any Topic page)   */
/* ------------------------------------------------------------------ */

/** Structured learning guide returned by POST /api/ai/learning-guide. */
export interface LearningGuide {
  topic: string
  overview: string
  what_to_learn: string[]
  key_concepts: string[]
  simple_explanation: string
  example: string
  common_mistakes: string[]
  prerequisites: string[]
  quick_check: { question: string; answer: string }[]
  what_to_learn_next: string[]
}

/** What we send to the Python backend — never includes any API key. */
export interface LearningGuideInput {
  query: string
  video_title: string
  video_description: string
  student_level: string
}

export type LearningGuideResult =
  | { state: 'ready'; guide: LearningGuide }
  | { state: 'error'; message: string }

/** Backend route served by backend/server.py (Groq). */
const LEARNING_GUIDE_API = apiUrl('/api/ai/learning-guide')

/** Fetch with a hard timeout so a slow AI call never hangs the UI. */
async function fetchLeGuideWithTimeout(body: LearningGuideInput, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(LEARNING_GUIDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Request an AI Learning Guide from the Groq-powered backend.
 *
 * Never throws, never touches the API key (it lives only in the backend).
 * On any failure it returns an error result so the UI can show a friendly
 * message — the rest of the page keeps working.
 */
export async function getLearningGuide(input: LearningGuideInput): Promise<LearningGuideResult> {
  const trimmed = {
    query: (input.query || '').trim().slice(0, 200),
    video_title: (input.video_title || '').trim().slice(0, 300),
    video_description: (input.video_description || '').trim().slice(0, 3000),
    student_level: (input.student_level || 'beginner').trim().slice(0, 20),
  }
  if (!trimmed.query) return { state: 'error', message: 'Please enter a topic to study.' }

  try {
    const res = await fetchLeGuideWithTimeout(trimmed, 90000)
    const data = (await res.json().catch(() => null)) as
      | { guide?: Partial<LearningGuide> }
      | null
      | undefined
    if (!res.ok || !data?.guide) {
      // Backend sent a user-friendly error (e.g. missing key, AI failure).
      const message =
        (data as { error?: string } | null | undefined)?.error ||
        'The AI learning guide is unavailable right now. Please try again.'
      return { state: 'error', message }
    }
    return { state: 'ready', guide: data.guide as LearningGuide }
  } catch {
    // Backend unreachable or request timed out.
    return {
      state: 'error',
      message: 'The AI learning guide is unavailable right now. Please try again.',
    }
  }
}

/* ------------------------------------------------------------------ */
/* AI Topic Q&A — real Groq-backed, strictly on-topic (Learn Any Topic) */
/* ------------------------------------------------------------------ */

/** A question the student asks about the topic being studied. */
export interface TopicQuestionInput {
  query: string
  question: string
  video_title?: string
  video_description?: string
  student_level?: string
  /** Previous turns so follow-up questions keep context. */
  history?: AssistantMessage[]
}

export type TopicQuestionResult =
  | { state: 'ready'; answer: string }
  | { state: 'error'; message: string }

/** Backend route served by backend/server.py (Groq). */
const TOPIC_ASK_API = apiUrl('/api/ai/ask')

/**
 * Ask a question about the current topic. The backend enforces that only
 * on-topic questions are answered; off-topic ones are politely declined.
 * Never throws and never touches the API key.
 */
export async function askTopicQuestion(input: TopicQuestionInput): Promise<TopicQuestionResult> {
  const query = (input.query || '').trim().slice(0, 200)
  const question = (input.question || '').trim().slice(0, 2000)
  if (!query || !question) {
    return { state: 'error', message: 'Ask a question about the topic you are studying.' }
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 90000)
  try {
    const res = await fetch(TOPIC_ASK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        question,
        video_title: (input.video_title || '').slice(0, 300),
        video_description: (input.video_description || '').slice(0, 3000),
        student_level: (input.student_level || 'beginner').slice(0, 20),
        history: (input.history || []).map((m) => ({ role: m.role, content: m.text })),
      }),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as
      | { answer?: string; error?: string }
      | null
      | undefined
    if (!res.ok || !data?.answer) {
      return {
        state: 'error',
        message: data?.error || 'The AI tutor is unavailable right now. Please try again.',
      }
    }
    return { state: 'ready', answer: data.answer }
  } catch {
    return {
      state: 'error',
      message: 'The AI tutor is unavailable right now. Please try again.',
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Adaptive performance analysis — real Groq-backed                     */
/* ------------------------------------------------------------------ */

/** Input for AI performance analysis. */
export interface AnalyzePerformanceInput {
  roadmap_topic: string
  quiz_score: number
  total_questions: number
  questions: { prompt: string; options: string[]; correctIndex: number; concept: string; difficulty?: string }[]
  answers: number[]
  correct_answers: number[]
}

/** Backend analysis response shape. */
export interface PerformanceAnalysisResult {
  state: 'ready'
  analysis: {
    score: number
    status: 'pass' | 'needs_practice' | 'review_required'
    strong_topics: string[]
    weak_topics: string[]
    revision_plan: { topic: string; reason: string; priority: string }[]
    practice_recommendation: string
    retest_required: boolean
    recommended_next_topic: string
    message: string
  }
}

export type AnalyzePerformanceOutput =
  | PerformanceAnalysisResult
  | { state: 'error'; message: string }

const ANALYZE_API = apiUrl('/api/ai/analyze-performance')

/**
 * Send quiz results to the backend for AI-powered performance analysis.
 * Never throws and never touches the API key.
 */
export async function analyzeQuizPerformance(
  input: AnalyzePerformanceInput,
): Promise<AnalyzePerformanceOutput> {
  if (!input.roadmap_topic) {
    return { state: 'error', message: 'Missing topic information.' }
  }
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 90000)
    try {
      const res = await fetch(ANALYZE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roadmap_topic: input.roadmap_topic.slice(0, 200),
          quiz_score: input.quiz_score,
          total_questions: input.total_questions,
          questions: input.questions.slice(0, 60),
          answers: input.answers.slice(0, 60),
          correct_answers: input.correct_answers.slice(0, 60),
        }),
        signal: controller.signal,
      })
      const data = (await res.json().catch(() => null)) as
        | { analysis?: PerformanceAnalysisResult['analysis']; error?: string }
        | null
        | undefined
      if (!res.ok || !data?.analysis) {
        return {
          state: 'error',
          message: data?.error || 'The AI analysis is unavailable right now.',
        }
      }
      return { state: 'ready', analysis: data.analysis }
    } finally {
      window.clearTimeout(timer)
    }
  } catch {
    return {
      state: 'error',
      message: 'The AI analysis is unavailable right now. Please try again.',
    }
  }
}

/* ------------------------------------------------------------------ */
/* Next-topic recommendation — real Groq-backed                         */
/* ------------------------------------------------------------------ */

/** Input for AI next-topic recommendation. */
export interface RecommendNextInput {
  roadmap_goal: string
  roadmap_topics: { name: string; status: string; lastScore?: number }[]
  completed_topics: string[]
  quiz_history: { topic: string; score: number }[]
  weak_topics: string[]
  current_topic: string
}

/** Backend recommendation response shape. */
export interface NextRecommendationResult {
  state: 'ready'
  recommendation: {
    action: 'continue' | 'review' | 'practice'
    next_topic: string
    reason: string
  }
}

export type RecommendNextOutput =
  | NextRecommendationResult
  | { state: 'error'; message: string }

const RECOMMEND_API = apiUrl('/api/ai/recommend-next-topic')

/**
 * Ask the AI for the next recommended learning activity.
 * Never throws and never touches the API key.
 */
export async function recommendNextTopic(
  input: RecommendNextInput,
): Promise<RecommendNextOutput> {
  if (!input.roadmap_goal || !input.current_topic) {
    return { state: 'error', message: 'Missing roadmap information.' }
  }
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 90000)
    try {
      const res = await fetch(RECOMMEND_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roadmap_goal: input.roadmap_goal.slice(0, 200),
          roadmap_topics: input.roadmap_topics.slice(0, 30),
          completed_topics: input.completed_topics.slice(0, 30),
          quiz_history: input.quiz_history.slice(0, 20),
          weak_topics: input.weak_topics.slice(0, 20),
          current_topic: input.current_topic.slice(0, 200),
        }),
        signal: controller.signal,
      })
      const data = (await res.json().catch(() => null)) as
        | { recommendation?: NextRecommendationResult['recommendation']; error?: string }
        | null
        | undefined
      if (!res.ok || !data?.recommendation) {
        return {
          state: 'error',
          message: data?.error || 'The AI recommendation is unavailable right now.',
        }
      }
      return { state: 'ready', recommendation: data.recommendation }
    } finally {
      window.clearTimeout(timer)
    }
  } catch {
    return {
      state: 'error',
      message: 'The AI recommendation is unavailable right now. Please try again.',
    }
  }
}

/* ------------------------------------------------------------------ */
/* Dynamic roadmap creation — real Groq-backed (any topic)              */
/* ------------------------------------------------------------------ */

/** Backend roadmap response shape. */
export interface CreateRoadmapResult {
  roadmap: AiGeneratedRoadmap
}
export type CreateRoadmapOutput =
  | { state: 'ready'; roadmap: AiGeneratedRoadmap }
  | { state: 'error'; message: string; blocked?: boolean }

const CREATE_ROADMAP_API = apiUrl('/api/ai/create-roadmap')

/**
 * Generate a personalized learning roadmap for ANY topic.
 * The backend runs SafeSearch → internet search → Groq and returns a
 * validated structured roadmap. Never throws and never touches the API key.
 */
export async function createRoadmap(input: {
  topic: string
  level?: string
  study_time?: string
  goal?: string
}): Promise<CreateRoadmapOutput> {
  const topic = (input.topic || '').trim().slice(0, 200)
  if (!topic) {
    return { state: 'error', message: 'Enter a topic you want to learn.' }
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 180000)
  try {
    const res = await fetch(CREATE_ROADMAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        level: (input.level || 'beginner').slice(0, 20),
        study_time: (input.study_time || '1 hour/day').slice(0, 50),
        goal: (input.goal || 'general learning').slice(0, 200),
      }),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as
      | { roadmap?: AiGeneratedRoadmap; error?: string }
      | null
      | undefined
    if (res.status === 422) {
      return {
        state: 'error',
        blocked: true,
        message: data?.error || 'This topic isn\'t available on FocusLearn.',
      }
    }
    if (!res.ok || !data?.roadmap) {
      return {
        state: 'error',
        message: data?.error || 'Unable to generate your roadmap right now. Please try again.',
      }
    }
    return { state: 'ready', roadmap: data.roadmap }
  } catch {
    return {
      state: 'error',
      message: 'Unable to generate your roadmap right now. Please try again.',
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Topic quiz generation — real Groq-backed, 30+ questions             */
/* ------------------------------------------------------------------ */

const QUIZ_DIFFICULTIES: QuizDifficulty[] = ['basic', 'moderate', 'advanced']

/** Normalize a raw tier label (legacy "intermediate" -> "moderate"). */
function normalizeDifficulty(raw: unknown): QuizDifficulty | undefined {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'intermediate' || value === 'medium') return 'moderate'
  return QUIZ_DIFFICULTIES.includes(value as QuizDifficulty)
    ? (value as QuizDifficulty)
    : undefined
}

/** Question shape returned by the backend quiz generator. */
interface RawQuizQuestion {
  id?: string
  prompt?: string
  options?: unknown
  correctIndex?: unknown
  explanation?: string
  concept?: string
  difficulty?: string
}

export interface GenerateTopicQuizInput {
  topic: string
  level?: string
  /** Number of questions to request (6-60, defaults to 30). */
  count?: number
  /** Weak concepts to focus a retest on. */
  concepts?: string[]
}

export type GenerateTopicQuizOutput =
  | { state: 'ready'; quiz: Quiz }
  | { state: 'error'; message: string; blocked?: boolean }

const GENERATE_QUIZ_API = apiUrl('/api/ai/generate-quiz')

/**
 * Generate a validated topic quiz with 30+ multiple-choice questions
 * (10 basic / 10 moderate / 10 advanced by default), ordered easiest
 * first. The backend runs SafeSearch, Groq generation, de-duplication and
 * validation. Never throws and never touches the API key.
 */
export async function generateTopicQuiz(
  input: GenerateTopicQuizInput,
): Promise<GenerateTopicQuizOutput> {
  const topic = (input.topic || '').trim().slice(0, 200)
  if (!topic) {
    return { state: 'error', message: 'Enter a topic to generate a quiz.' }
  }

  const rawCount = Number(input.count)
  const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.min(Math.max(Math.round(rawCount), 6), 60) : 30
  const concepts = (input.concepts || [])
    .map((c) => String(c).trim())
    .filter(Boolean)
    .slice(0, 12)

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 180000)
  try {
    const res = await fetch(GENERATE_QUIZ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        level: (input.level || 'beginner').slice(0, 20),
        count,
        concepts,
      }),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as
      | { quiz?: { questions?: RawQuizQuestion[] }; error?: string }
      | null
      | undefined
    if (res.status === 422) {
      return {
        state: 'error',
        blocked: true,
        message: data?.error || "This topic isn't available on FocusLearn.",
      }
    }
    const rawQuestions = data?.quiz?.questions
    if (!res.ok || !Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        state: 'error',
        message: data?.error || 'Unable to generate a quiz right now. Please try again.',
      }
    }

    const questions: QuizQuestion[] = rawQuestions
      .map((raw, index): QuizQuestion | null => {
        const prompt = String(raw.prompt || '').trim()
        const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : []
        const correctIndex = Number(raw.correctIndex)
        if (
          !prompt ||
          options.length < 2 ||
          !Number.isInteger(correctIndex) ||
          correctIndex < 0 ||
          correctIndex >= options.length
        ) {
          return null
        }
        const difficulty = normalizeDifficulty(raw.difficulty)
        return {
          id: raw.id || `q${index + 1}`,
          prompt,
          options,
          correctIndex,
          explanation: String(raw.explanation || '').trim(),
          concept: raw.concept ? String(raw.concept).trim() : undefined,
          difficulty,
        }
      })
      .filter((q): q is QuizQuestion => q !== null)

    if (questions.length === 0) {
      return {
        state: 'error',
        message: 'Unable to generate a quiz right now. Please try again.',
      }
    }

    const normalized = normalizeTopic(topic)
    const slug = topicHaystack(normalized).replace(/\s/g, '-')
    return {
      state: 'ready',
      quiz: {
        id: `quiz-topic-${slug}`,
        lessonId: `topic-${slug}`,
        title: `${normalized} — Check`,
        source: 'topic',
        topic: normalized,
        level: (input.level || 'beginner').slice(0, 20),
        questions,
      },
    }
  } catch {
    return {
      state: 'error',
      message: 'Unable to generate a quiz right now. Please try again.',
    }
  } finally {
    window.clearTimeout(timer)
  }
}
