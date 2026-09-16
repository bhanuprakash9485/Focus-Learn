import type { AiRoadmap, AiRoadmapTopic } from '../types'

/**
 * Mock "AI-generated" roadmap for the demo goal
 * "Master Data Structures and Algorithms".
 * Local data only — in the AI version this shape is produced by the model.
 */
const topics: AiRoadmapTopic[] = [
  {
    id: 'ai-fundamentals',
    name: 'Programming Fundamentals',
    description: 'Variables, loops, functions and problem-solving basics every topic builds on.',
    overview:
      'Before touching any data structure, you need fluency with the building blocks: variables, conditionals, loops, functions and how code actually runs. This topic gets you writing small programs confidently and reading other code without getting lost.',
    status: 'completed',
    progress: 100,
    difficulty: 'Beginner',
    estimatedTime: '1 week',
    estimatedHours: 12,
    prerequisites: [],
    skillsGained: ['Problem decomposition', 'Loops & conditionals', 'Functions', 'Big-O intuition'],
  },
  {
    id: 'ai-arrays',
    name: 'Arrays',
    description: 'Store and access ordered data — indexing, traversal and two-pointer tricks.',
    overview:
      'Arrays are the backbone of almost every interview question. You will learn how indexing and resizing really work, the cost of insertions and deletions, and the two most useful patterns: sliding window and two pointers.',
    status: 'completed',
    progress: 100,
    difficulty: 'Beginner',
    estimatedTime: '1 week',
    estimatedHours: 14,
    prerequisites: ['Programming Fundamentals'],
    skillsGained: ['Two-pointer technique', 'Sliding window', 'In-place operations'],
  },
  {
    id: 'ai-strings',
    name: 'Strings',
    description: 'Treat text as data: reversal, palindromes, anagrams and pattern scanning.',
    overview:
      'Strings are arrays with personality. You will practice the classic patterns — two pointers from both ends, frequency maps and building strings efficiently — until palindrome and anagram questions feel routine.',
    status: 'current',
    progress: 60,
    difficulty: 'Beginner',
    estimatedTime: '1 week',
    estimatedHours: 12,
    prerequisites: ['Arrays'],
    skillsGained: ['Frequency counting', 'Palindrome patterns', 'Anagram detection'],
  },
  {
    id: 'ai-linked-lists',
    name: 'Linked Lists',
    description: 'Chain nodes with pointers and master traversal, reversal and cycle detection.',
    overview:
      'Linked lists teach pure pointer manipulation. You will implement singly and doubly linked lists, use dummy heads to simplify edge cases, and learn the fast & slow pointer technique for finding middles and detecting cycles.',
    status: 'recommended',
    progress: 0,
    difficulty: 'Intermediate',
    estimatedTime: '1.5 weeks',
    estimatedHours: 18,
    prerequisites: ['Arrays'],
    skillsGained: ['Pointer manipulation', 'Fast & slow pointers', 'List reversal'],
  },
  {
    id: 'ai-stacks-queues',
    name: 'Stacks & Queues',
    description: 'LIFO and FIFO structures behind parsers, schedulers and BFS.',
    overview:
      'Stacks power undo, expression parsing and DFS; queues power schedulers and BFS. You will build both from arrays and linked lists, then solve classics like valid parentheses and min-stack.',
    status: 'locked',
    progress: 0,
    difficulty: 'Intermediate',
    estimatedTime: '1 week',
    estimatedHours: 14,
    prerequisites: ['Linked Lists'],
    skillsGained: ['LIFO/FIFO thinking', 'Monotonic stack', 'Queue-based BFS'],
  },
  {
    id: 'ai-recursion',
    name: 'Recursion',
    description: 'Solve problems by solving smaller versions of themselves — the gateway to trees and DP.',
    overview:
      'Recursion is a mindset: define the base case, trust the smaller call, combine the results. You will learn to trace call stacks, convert recursion to iteration, and spot recursive structure hiding inside problems.',
    status: 'review-required',
    progress: 45,
    difficulty: 'Intermediate',
    estimatedTime: '1.5 weeks',
    estimatedHours: 16,
    prerequisites: ['Stacks & Queues'],
    skillsGained: ['Base-case design', 'Call-stack tracing', 'Backtracking basics'],
    reviewNote: 'Quiz score 55% — below the 70% mastery threshold.',
  },
  {
    id: 'ai-searching',
    name: 'Searching',
    description: 'Linear and binary search — the fastest way to find things in ordered data.',
    overview:
      'Binary search halves the search space every step. You will master the invariant-based template, then apply it beyond arrays: search-on-answer problems and rotated sorted arrays.',
    status: 'locked',
    progress: 0,
    difficulty: 'Intermediate',
    estimatedTime: '1 week',
    estimatedHours: 12,
    prerequisites: ['Recursion'],
    skillsGained: ['Binary search template', 'Search-space reduction', 'Complexity analysis'],
  },
  {
    id: 'ai-sorting',
    name: 'Sorting',
    description: 'Compare merge, quick and heap sort — and know when each one wins.',
    overview:
      'Sorting is the most-asked interview family. You will implement the O(n log n) divide-and-conquer algorithms, understand stability, and learn when linear-time sorts like counting sort are the right call.',
    status: 'locked',
    progress: 0,
    difficulty: 'Intermediate',
    estimatedTime: '1.5 weeks',
    estimatedHours: 16,
    prerequisites: ['Searching'],
    skillsGained: ['Divide & conquer', 'Stability concepts', 'Custom comparators'],
  },
  {
    id: 'ai-trees',
    name: 'Trees',
    description: 'Hierarchical data: traversals, BSTs and recursion made visual.',
    overview:
      'Trees combine structure with recursion. You will learn pre-, in- and post-order traversals, binary search tree invariants, and how height and balance affect every operation.',
    status: 'locked',
    progress: 0,
    difficulty: 'Advanced',
    estimatedTime: '2 weeks',
    estimatedHours: 20,
    prerequisites: ['Sorting'],
    skillsGained: ['Tree traversals', 'BST operations', 'Recursive thinking'],
  },
  {
    id: 'ai-graphs',
    name: 'Graphs',
    description: 'Model networks and relationships with BFS, DFS and shortest paths.',
    overview:
      'Graphs generalize every structure so far. You will build adjacency lists, run BFS and DFS, detect cycles, order tasks with topological sort and meet Dijkstra for weighted shortest paths.',
    status: 'locked',
    progress: 0,
    difficulty: 'Advanced',
    estimatedTime: '2 weeks',
    estimatedHours: 20,
    prerequisites: ['Trees'],
    skillsGained: ['BFS & DFS', 'Topological sort', 'Shortest-path basics'],
  },
  {
    id: 'ai-dp',
    name: 'Dynamic Programming',
    description: 'Learn the pattern, not the problems: overlapping subproblems and optimal substructure.',
    overview:
      'DP is recursion plus memory. Starting from Fibonacci and memoization, you will climb to classic patterns — house robber, knapsack, longest common subsequence — learning to convert recursion into memo, then into a table.',
    status: 'locked',
    progress: 0,
    difficulty: 'Advanced',
    estimatedTime: '2.5 weeks',
    estimatedHours: 24,
    prerequisites: ['Graphs', 'Recursion'],
    skillsGained: ['Memoization', 'Tabulation', 'State design'],
  },
]

/**
 * In the AI version this calls the model to personalize the roadmap;
 * for now it returns local mock data.
 */
export function getAiRoadmap(): AiRoadmap {
  return {
    id: 'ai-roadmap-dsa',
    goal: 'Master Data Structures and Algorithms',
    tagline:
      'Generated from your goal, quiz history and pace. The path adapts as you learn — topics where you struggle are flagged for review automatically.',
    topics,
  }
}
