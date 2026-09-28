"""
curated_webdev.py - Manually supplied Web Development question set.

30 questions (10 basic, 10 moderate, 10 difficult -> stored as the internal
``advanced`` tier) for the "Web Development" goal/topic. The questions and
their four options are used EXACTLY as supplied; every question has exactly one
correct answer. ``explanation`` is derived from the correct option so the quiz
display contract (which requires an explanation) is met without inventing new
subject content.

Only the Web Development goal/topic is routed to this curated set: everything
else keeps going through the normal AI authoring pipeline.
"""

from __future__ import annotations

SOURCE_TYPE_MANUAL = "manually_supplied"

# Normalised (lower-cased, punctuation-stripped) topic aliases that resolve to
# the curated Web Development set. Normalisation matches
# quiz_originality.normalize_text: "Web Development" -> "web development".
TOPIC_ALIASES = frozenset(
    {
        "web development",
        "webdev",
    }
)

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
        "What does HTML stand for?",
        [
            "Hyper Text Markup Language",
            "High Text Machine Language",
            "Hyperlink Text Management Language",
            "Home Tool Markup Language",
        ],
        "Hyper Text Markup Language",
    ),
    (
        "basic",
        "Which HTML tag is used for the largest heading?",
        ["<heading>", "<h6>", "<h1>", "<head>"],
        "<h1>",
    ),
    (
        "basic",
        "Which HTML tag is used to create a paragraph?",
        ["<para>", "<p>", "<text>", "<paragraph>"],
        "<p>",
    ),
    (
        "basic",
        "Which HTML element is used to create a hyperlink?",
        ["<link>", "<href>", "<a>", "<url>"],
        "<a>",
    ),
    (
        "basic",
        "What does CSS stand for?",
        [
            "Computer Style Sheets",
            "Cascading Style Sheets",
            "Creative Style System",
            "Colorful Style Sheets",
        ],
        "Cascading Style Sheets",
    ),
    (
        "basic",
        "Which CSS property changes text color?",
        ["background", "font-color", "color", "text-color"],
        "color",
    ),
    (
        "basic",
        "Which JavaScript keyword is used to declare a block-scoped variable that can be reassigned?",
        ["var", "let", "const", "static"],
        "let",
    ),
    (
        "basic",
        "Which HTML tag is used to display an image?",
        ["<image>", "<picture>", "<img>", "<src>"],
        "<img>",
    ),
    (
        "basic",
        "Which CSS property is used to change the background color?",
        ["color", "background-color", "bg-color", "background-style"],
        "background-color",
    ),
    (
        "basic",
        "Which language is primarily used to add interactivity to web pages?",
        ["HTML", "CSS", "JavaScript", "SQL"],
        "JavaScript",
    ),
    (
        "moderate",
        "Which CSS layout system is designed for one-dimensional layouts?",
        ["Grid", "Flexbox", "Table", "Float"],
        "Flexbox",
    ),
    (
        "moderate",
        "Which CSS layout system is commonly used for two-dimensional layouts?",
        ["Flexbox", "Grid", "Inline", "Float"],
        "Grid",
    ),
    (
        "moderate",
        "Which JavaScript method selects an element by its ID?",
        [
            "document.getElementById()",
            "document.getElement()",
            "document.selectId()",
            "document.findId()",
        ],
        "document.getElementById()",
    ),
    (
        "moderate",
        "What does DOM stand for?",
        [
            "Document Object Model",
            "Data Object Management",
            "Document Oriented Method",
            "Digital Object Model",
        ],
        "Document Object Model",
    ),
    (
        "moderate",
        "Which HTTP method is commonly used to retrieve data from a server?",
        ["POST", "GET", "DELETE", "PATCH"],
        "GET",
    ),
    (
        "moderate",
        "Which HTTP status code indicates that a resource was successfully found and returned?",
        ["200", "301", "404", "500"],
        "200",
    ),
    (
        "moderate",
        'Which HTTP status code means "Not Found"?',
        ["200", "201", "404", "500"],
        "404",
    ),
    (
        "moderate",
        "What is the purpose of JavaScript's addEventListener()?",
        [
            "Create a database",
            "Attach an event handler to an element",
            "Change the server",
            "Create an HTML document",
        ],
        "Attach an event handler to an element",
    ),
    (
        "moderate",
        "Which HTML attribute provides alternative text for an image?",
        ["title", "src", "alt", "text"],
        "alt",
    ),
    (
        "moderate",
        "Which technology is commonly used for storing structured data in a web browser on the client side?",
        ["localStorage", "HTML", "CSS", "DNS"],
        "localStorage",
    ),
    (
        "difficult",
        "What is the main purpose of responsive web design?",
        [
            "Make websites work only on desktops",
            "Make websites adapt to different screen sizes and devices",
            "Increase database storage",
            "Replace JavaScript",
        ],
        "Make websites adapt to different screen sizes and devices",
    ),
    (
        "difficult",
        "Which CSS property controls the space between an element's content and its border?",
        ["margin", "padding", "spacing", "gap"],
        "padding",
    ),
    (
        "difficult",
        "Which CSS property controls the space outside an element's border?",
        ["padding", "margin", "border-spacing", "outside"],
        "margin",
    ),
    (
        "difficult",
        "What is an API primarily used for in web development?",
        [
            "Styling HTML elements",
            "Allowing software components to communicate with each other",
            "Creating CSS animations only",
            "Compressing images",
        ],
        "Allowing software components to communicate with each other",
    ),
    (
        "difficult",
        "What is JSON commonly used for in web applications?",
        [
            "Styling web pages",
            "Representing and exchanging structured data",
            "Creating database indexes only",
            "Compiling JavaScript",
        ],
        "Representing and exchanging structured data",
    ),
    (
        "difficult",
        "Which JavaScript feature is commonly used to handle asynchronous operations?",
        ["Promises", "Classes only", "CSS Grid", "HTML forms"],
        "Promises",
    ),
    (
        "difficult",
        "What is the purpose of async and await in JavaScript?",
        [
            "Create CSS styles",
            "Make working with Promises easier to read and manage",
            "Create HTML elements only",
            "Define database tables",
        ],
        "Make working with Promises easier to read and manage",
    ),
    (
        "difficult",
        "Which HTTP status code generally indicates an internal server error?",
        ["200", "301", "404", "500"],
        "500",
    ),
    (
        "difficult",
        "What is CORS primarily related to?",
        [
            "Styling responsive pages",
            "Controlling cross-origin requests made by web applications",
            "Compressing JavaScript",
            "Creating HTML tables",
        ],
        "Controlling cross-origin requests made by web applications",
    ),
    (
        "difficult",
        "What is the primary purpose of a frontend framework such as React?",
        [
            "Manage physical servers",
            "Build and manage interactive user interfaces",
            "Replace databases",
            "Configure DNS servers",
        ],
        "Build and manage interactive user interfaces",
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
                "concept": "web development",
                "source_type": SOURCE_TYPE_MANUAL,
            }
        )
    return questions