import type { Quiz, QuizAttempt, User } from '../types'

/** The sample student used across the app while there is no backend. */
export const sampleStudent: User = {
  id: 'student-001',
  name: 'Asha Verma',
  email: 'asha.verma@focuslearn.app',
  field: 'Web Development',
  level: 'Beginner',
  dailyGoalMinutes: 30,
  joinedAt: '2026-09-01',
  focusStreakDays: 6,
}

/** Quizzes keyed by lesson id — the "understanding check" content. */
export const quizzes: Record<string, Quiz> = {
  'web-dev-1-1': {
    id: 'quiz-web-dev-1-1',
    lessonId: 'web-dev-1-1',
    title: 'How the Web Works — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'What is the correct order of the request flow when you open a website?',
        options: [
          'Server → browser request → response → page',
          'Browser request → server response → page renders',
          'Page renders → browser request → server response',
          'Server pushes the page without any request',
        ],
        correctIndex: 1,
        explanation:
          'The browser (client) sends a request, the server responds with files, and the browser renders the page.',
      },
      {
        id: 'q2',
        prompt: 'Which technology is responsible for the *structure* of a page?',
        options: ['CSS', 'JavaScript', 'HTML', 'The server database'],
        correctIndex: 2,
        explanation: 'HTML provides structure; CSS adds style and JavaScript adds behavior.',
      },
    ],
  },
  'web-dev-1-2': {
    id: 'quiz-web-dev-1-2',
    lessonId: 'web-dev-1-2',
    title: 'Semantic HTML — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'Why prefer semantic tags over generic <div>s?',
        options: [
          'They render faster on all browsers',
          'They improve accessibility, SEO and code readability',
          'They reduce the file size dramatically',
          'Semantic tags are required by HTML validators',
        ],
        correctIndex: 1,
        explanation:
          'Semantic elements convey meaning: screen readers, search engines and developers all benefit.',
      },
      {
        id: 'q2',
        prompt: 'Which element should wrap the unique main content of a page?',
        options: ['<header>', '<main>', '<footer>', '<nav>'],
        correctIndex: 1,
        explanation: '<main> marks the unique primary content; it should appear only once per page.',
      },
    ],
  },
  'web-dev-2-2': {
    id: 'quiz-web-dev-2-2',
    lessonId: 'web-dev-2-2',
    title: 'Flexbox, Grid & Responsive — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'You need a photo gallery with fixed rows and columns. Which layout is the best fit?',
        options: ['Floats', 'CSS Grid', 'Position absolute', 'Inline-block spacing'],
        correctIndex: 1,
        explanation: 'Grid excels at two-dimensional layouts where the layout defines the structure.',
      },
      {
        id: 'q2',
        prompt: 'What is the role of a media query in responsive design?',
        options: [
          'It compresses images for mobile',
          'It applies CSS only at certain screen sizes',
          'It queries the database for mobile users',
          'It animates layout changes',
        ],
        correctIndex: 1,
        explanation: 'Media queries conditionally apply styles based on device characteristics like width.',
      },
    ],
  },
  'web-dev-3-2': {
    id: 'quiz-web-dev-3-2',
    lessonId: 'web-dev-3-2',
    title: 'DOM & Events — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'Which method attaches a click reaction to a button element?',
        options: [
          'button.onClick()',
          'button.addEventListener("click", handler)',
          'document.click(button)',
          'button.querySelector("click")',
        ],
        correctIndex: 1,
        explanation: 'addEventListener registers a handler for a named event on an element.',
      },
      {
        id: 'q2',
        prompt: 'In the "state → DOM" mental model, what triggers a UI update?',
        options: [
          'A CSS animation finishes',
          'The page reloads',
          'Your code updates state, then the UI reflects it',
          'The user closes a tab',
        ],
        correctIndex: 2,
        explanation: 'Events change state; the UI is rendered from that state. This loop underlies React too.',
      },
    ],
  },
  'web-dev-4-2': {
    id: 'quiz-web-dev-4-2',
    lessonId: 'web-dev-4-2',
    title: 'State & useEffect — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'What happens when you call a state setter like setCount(5)?',
        options: [
          'The DOM is edited directly',
          'The page reloads',
          'The component re-renders with the new state',
          'Nothing until you refresh',
        ],
        correctIndex: 2,
        explanation: 'Changing state schedules a re-render, and the UI updates from the new state.',
      },
      {
        id: 'q2',
        prompt: 'Which task belongs in useEffect rather than during render?',
        options: [
          'Computing a total from props',
          'Setting up a timer subscription',
          'Formatting a display name',
          'Choosing which icon to show',
        ],
        correctIndex: 1,
        explanation:
          'Effects are for syncing with outside systems — timers, subscriptions, fetching — not pure calculations.',
      },
    ],
  },
  'python-1-2': {
    id: 'quiz-python-1-2',
    lessonId: 'python-1-2',
    title: 'Lists, Loops & Logic — Check',
    questions: [
      {
        id: 'q1',
        prompt: 'scores = [90, 74, 88]. What does the loop "for s in scores" do?',
        options: [
          'Sorts the list in place',
          'Visits each score one at a time as s',
          'Removes duplicates',
          'Creates a copy of the list',
        ],
        correctIndex: 1,
        explanation: 'A for-each loop iterates over each element, binding it to the loop variable.',
      },
      {
        id: 'q2',
        prompt: 'Which statement conditionally runs code?',
        options: ['for', 'if', 'print', 'def'],
        correctIndex: 1,
        explanation: 'if decides whether a block runs; for repeats it; def defines a function.',
      },
    ],
  },
}

/** Mock quiz attempt history for the Performance page. */
export const mockAttempts: QuizAttempt[] = [
  {
    id: 'att-1',
    lessonId: 'web-dev-1-1',
    score: 2,
    total: 2,
    percentage: 100,
    completedAt: '2026-09-08',
    missedQuestionIds: [],
  },
  {
    id: 'att-2',
    lessonId: 'web-dev-1-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-09',
    missedQuestionIds: ['q2'],
  },
  {
    id: 'att-3',
    lessonId: 'web-dev-2-2',
    score: 2,
    total: 2,
    percentage: 100,
    completedAt: '2026-09-11',
    missedQuestionIds: [],
  },
  {
    id: 'att-4',
    lessonId: 'web-dev-3-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-12',
    missedQuestionIds: ['q1'],
  },
  {
    id: 'att-5',
    lessonId: 'web-dev-4-2',
    score: 1,
    total: 2,
    percentage: 50,
    completedAt: '2026-09-13',
    missedQuestionIds: ['q2'],
  },
]
