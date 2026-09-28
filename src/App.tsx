import { Navigate, Route, Routes } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ProtectedRoute } from './components/ProtectedRoute'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import WhatShouldIStudy from './pages/WhatShouldIStudy'
import Goals from './pages/Goals'
import RoadmapPage from './pages/Roadmap'
import AiRoadmapPage from './pages/AiRoadmap'
import Focus from './pages/Focus'
import VideoSearch from './pages/VideoSearch'
import Quiz from './pages/Quiz'
import Performance from './pages/Performance'
import KnowledgeMap from './pages/KnowledgeMap'
import StudyPlan from './pages/StudyPlan'
import Profile from './pages/Profile'
import Settings from './pages/Settings'

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Routes>
      {/* Public pages */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      {/* Authenticated app (redirects to /login when logged out) */}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/what-should-i-study" element={<WhatShouldIStudy />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/ai-roadmap" element={<AiRoadmapPage />} />
        <Route path="/focus" element={<Focus />} />
        <Route path="/focus/topic/:videoId" element={<Focus />} />
        <Route path="/focus/:lessonId" element={<Focus />} />
        <Route path="/search" element={<VideoSearch />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/quiz/topic/:topic" element={<Quiz />} />
        <Route path="/quiz/goal/:goalId" element={<Quiz />} />
        <Route path="/quiz/:lessonId" element={<Quiz />} />
        <Route path="/performance" element={<Performance />} />
        <Route path="/knowledge-map" element={<KnowledgeMap />} />
        <Route path="/study-plan" element={<StudyPlan />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </ErrorBoundary>
  )
}
