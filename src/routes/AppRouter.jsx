import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "../pages/Home";
import PropsDashboard from "../pages/PropsDashboard";
import LoginPage from "../pages/LoginPage";

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/props" element={<PropsDashboard />} />
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </BrowserRouter>
  );
}
