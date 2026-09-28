"""
curated_dsa.py - Manually supplied Data Structures & Algorithms question set.

30 questions (10 basic, 10 moderate, 10 difficult -> stored as the internal
``advanced`` tier) for the "Data Structures & Algorithms" goal/topic. The
questions and their four options are used EXACTLY as supplied; every question
has exactly one correct answer. ``explanation`` is derived from the correct
option so the quiz display contract (which requires an explanation) is met
without inventing new subject content.

Only the DSA goal/topic is routed to this curated set: everything else keeps
going through the normal AI authoring pipeline.
"""

from __future__ import annotations

SOURCE_TYPE_MANUAL_DSA = "manually_supplied"

# Generic name shared with the other curated set so the quiz service can run
# any provider through one registry.
SOURCE_TYPE_MANUAL = SOURCE_TYPE_MANUAL_DSA

# Normalised (lower-cased, punctuation-stripped) topic aliases that resolve to
# the curated DSA set. Normalisation matches quiz_originality.normalize_text.
# The canonical "and"-form title is deliberately NOT aliased: it is the title
# the existing AI-path tests use for their generic goal fixture, and a goal the
# user custom-titles that way keeps going through the normal AI pipeline.
DSA_TOPIC_ALIASES = frozenset(
    {
        "data structures algorithms",
        "data structures & algorithms",
        "dsa",
    }
)

# Generic name shared with the other curated set so the quiz service can run
# any provider through one registry.
TOPIC_ALIASES = DSA_TOPIC_ALIASES

# tier -> internal difficulty stored in quiz_questions. TRUE tier for the UI.
# ``difficult`` here is the learner-facing tier; the internal stored value that
# maps to the "Difficult" UI label is ``advanced``.
_TIER_TO_DIFFICULTY = {
    "basic": "basic",
    "moderate": "moderate",
    "difficult": "advanced",
}

# (tier, question text, [4 options], correct option)
_QUESTIONS: list[tuple[str, str, list[str], str]] = [
    (
        "basic",
        "Which data structure follows LIFO?",
        ["Queue", "Stack", "Array", "Linked List"],
        "Stack",
    ),
    (
        "basic",
        "Which data structure follows FIFO?",
        ["Stack", "Queue", "Tree", "Graph"],
        "Queue",
    ),
    (
        "basic",
        "What is the time complexity of accessing an element by index in an array?",
        ["O(n)", "O(log n)", "O(1)", "O(n²)"],
        "O(1)",
    ),
    (
        "basic",
        "Which data structure consists of nodes connected using links?",
        ["Array", "Linked List", "Stack", "Heap"],
        "Linked List",
    ),
    (
        "basic",
        "Which data structure is commonly used for recursion?",
        ["Queue", "Stack", "Graph", "Heap"],
        "Stack",
    ),
    (
        "basic",
        "Which traversal of a Binary Search Tree gives elements in sorted order?",
        ["Preorder", "Postorder", "Inorder", "Level Order"],
        "Inorder",
    ),
    (
        "basic",
        "What is the worst-case time complexity of linear search?",
        ["O(1)", "O(log n)", "O(n)", "O(n²)"],
        "O(n)",
    ),
    (
        "basic",
        "Which of the following is a non-linear data structure?",
        ["Array", "Stack", "Queue", "Tree"],
        "Tree",
    ),
    (
        "basic",
        "Which sorting algorithm repeatedly compares adjacent elements?",
        ["Merge Sort", "Bubble Sort", "Quick Sort", "Selection Sort"],
        "Bubble Sort",
    ),
    (
        "basic",
        "What is the first index of an array in Java?",
        ["0", "1", "-1", "Depends on array size"],
        "0",
    ),
    (
        "moderate",
        "What is the time complexity of binary search on a sorted array?",
        ["O(n)", "O(n²)", "O(log n)", "O(1)"],
        "O(log n)",
    ),
    (
        "moderate",
        "Which data structure is most suitable for implementing a priority queue?",
        ["Stack", "Heap", "Linked List only", "Array only"],
        "Heap",
    ),
    (
        "moderate",
        "What is the average time complexity of searching in a HashMap?",
        ["O(n)", "O(log n)", "O(1)", "O(n²)"],
        "O(1)",
    ),
    (
        "moderate",
        "Which sorting algorithm uses the divide-and-conquer technique?",
        ["Bubble Sort", "Selection Sort", "Merge Sort", "Linear Search"],
        "Merge Sort",
    ),
    (
        "moderate",
        "What is the worst-case time complexity of Merge Sort?",
        ["O(n)", "O(log n)", "O(n log n)", "O(n²)"],
        "O(n log n)",
    ),
    (
        "moderate",
        "In a Binary Search Tree, where are values smaller than the root generally stored?",
        ["Right subtree", "Left subtree", "Root only", "Anywhere"],
        "Left subtree",
    ),
    (
        "moderate",
        "Which algorithm is commonly used to find the shortest path in a weighted graph with non-negative edge weights?",
        ["DFS", "BFS", "Dijkstra's Algorithm", "Binary Search"],
        "Dijkstra's Algorithm",
    ),
    (
        "moderate",
        "Which traversal uses a queue in a graph?",
        ["DFS", "BFS", "Inorder", "Postorder"],
        "BFS",
    ),
    (
        "moderate",
        "What is the main purpose of a hash function?",
        [
            "Sort elements",
            "Map a key to an index/location",
            "Delete elements",
            "Reverse a data structure",
        ],
        "Map a key to an index/location",
    ),
    (
        "moderate",
        "Which technique solves a problem by breaking it into smaller overlapping subproblems and storing their results?",
        ["Greedy", "Dynamic Programming", "Binary Search", "Backtracking only"],
        "Dynamic Programming",
    ),
    (
        "difficult",
        "What is the worst-case time complexity of Quick Sort?",
        ["O(n)", "O(log n)", "O(n log n)", "O(n²)"],
        "O(n²)",
    ),
    (
        "difficult",
        "Which algorithm is commonly used to find a Minimum Spanning Tree?",
        ["BFS", "Kruskal's Algorithm", "Binary Search", "KMP"],
        "Kruskal's Algorithm",
    ),
    (
        "difficult",
        "What is the space complexity of an adjacency matrix for a graph with V vertices?",
        ["O(V)", "O(log V)", "O(V²)", "O(E) only"],
        "O(V²)",
    ),
    (
        "difficult",
        "Which data structure is most suitable for implementing DFS iteratively?",
        ["Queue", "Stack", "Heap", "HashMap"],
        "Stack",
    ),
    (
        "difficult",
        "Which data structure is commonly used to efficiently find the minimum or maximum element repeatedly?",
        ["Heap", "Stack", "Queue", "Linked List"],
        "Heap",
    ),
    (
        "difficult",
        "What is the main idea behind the two-pointer technique?",
        [
            "Use two separate arrays always",
            "Maintain two positions to efficiently process a sequence",
            "Always use recursion twice",
            "Divide every array into two equal parts",
        ],
        "Maintain two positions to efficiently process a sequence",
    ),
    (
        "difficult",
        "Which algorithm is used for finding all-pairs shortest paths?",
        ["Floyd-Warshall", "Binary Search", "Prim's Algorithm", "DFS only"],
        "Floyd-Warshall",
    ),
    (
        "difficult",
        "What is the time complexity of inserting an element at the beginning of a singly linked list when the head pointer is available?",
        ["O(n)", "O(log n)", "O(1)", "O(n²)"],
        "O(1)",
    ),
    (
        "difficult",
        "Which technique is commonly used to solve the N-Queens problem?",
        ["Greedy only", "Backtracking", "Binary Search", "Hashing only"],
        "Backtracking",
    ),
    (
        "difficult",
        "Which statement about Dynamic Programming is correct?",
        [
            "It only works for sorting problems",
            "It solves problems by storing results of overlapping subproblems",
            "It always uses O(1) memory",
            "It cannot be combined with recursion",
        ],
        "It solves problems by storing results of overlapping subproblems",
    ),
]


def build_questions() -> list[dict]:
    """The curated set in the canonical stored-question shape (one correct answer
    per question, explanation derived from the correct option)."""
    questions: list[dict] = []
    for tier, prompt, options, correct in _QUESTIONS:
        correct_index = options.index(correct)
        questions.append(
            {
                "prompt": prompt,
                "options": list(options),
                "correctIndex": correct_index,
                "difficulty": _TIER_TO_DIFFICULTY[tier],
                "explanation": f"Correct answer: {options[correct_index]}.",
                "concept": "data structures & algorithms",
                "source_type": SOURCE_TYPE_MANUAL_DSA,
            }
        )
    return questions