import type { Goal } from '../types'

/**
 * Catalog of learning goals a student can pick from.
 * In the AI version, goals may be suggested from a short prompt.
 */
export const goals: Goal[] = [
  {
    id: 'web-dev',
    title: 'Web Development',
    category: 'Programming',
    description:
      'Build modern, responsive websites and web apps using HTML, CSS, JavaScript and React.',
    difficulty: 'Beginner',
    estimatedWeeks: 8,
    icon: 'code',
    skills: ['HTML', 'CSS', 'JavaScript', 'React'],
  },
  {
    id: 'python-data',
    title: 'Python & Data Basics',
    category: 'Programming',
    description:
      'Learn Python from zero and analyze real datasets with lists, pandas-style thinking and charts.',
    difficulty: 'Beginner',
    estimatedWeeks: 6,
    icon: 'chart',
    skills: ['Python', 'Data Analysis', 'NumPy', 'Visualization'],
  },
  {
    id: 'ai-foundations',
    title: 'AI & Machine Learning',
    category: 'AI',
    description:
      'Understand how AI models learn, and build your first ML models with clear, visual explanations.',
    difficulty: 'Intermediate',
    estimatedWeeks: 10,
    icon: 'sparkles',
    skills: ['ML Basics', 'Models', 'Evaluation', 'Python'],
  },
  {
    id: 'dsa',
    title: 'Data Structures & Algorithms',
    category: 'Programming',
    description:
      'Master the core DSA patterns used in coding interviews, with step-by-step visual roadmaps.',
    difficulty: 'Intermediate',
    estimatedWeeks: 12,
    icon: 'branch',
    skills: ['Arrays', 'Trees', 'Graphs', 'Problem Solving'],
  },
  {
    id: 'design',
    title: 'UI/UX Design Fundamentals',
    category: 'Design',
    description:
      'Learn design thinking, layout, color and typography by redesigning real product screens.',
    difficulty: 'Beginner',
    estimatedWeeks: 6,
    icon: 'palette',
    skills: ['Design Thinking', 'Layout', 'Color', 'Figma'],
  },
  {
    id: 'dsa-math',
    title: 'Math for Competitive Exams',
    category: 'Academics',
    description:
      'Sharpen algebra, calculus and probability with focused practice plans and weak-area tracking.',
    difficulty: 'Advanced',
    estimatedWeeks: 9,
    icon: 'book',
    skills: ['Algebra', 'Calculus', 'Probability', 'Speed Practice'],
  },
]
