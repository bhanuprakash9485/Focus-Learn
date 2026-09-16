import { useParams } from 'react-router-dom'
import { FocusLessonMode } from './FocusLessonMode'
import TopicFocus from './TopicFocus'

/**
 * Focus Mode dispatcher.
 *
 *  - `/focus` and `/focus/:lessonId`   → original roadmap lesson reader.
 *  - `/focus/topic/:videoId`           → YouTube-powered Focus Mode, where
 *                                        the AI assistant is driven by the
 *                                        topic the student searched for.
 *
 * React Router ranks static segments above dynamic ones, so
 * `/focus/topic/:videoId` wins over `/focus/:lessonId` automatically.
 */
export default function Focus() {
  const { videoId, lessonId } = useParams()

  if (videoId) return <TopicFocus />
  // `/focus` with no lesson shows the roadmap lesson flow (unchanged behavior).
  void lessonId
  return <FocusLessonMode />
}
