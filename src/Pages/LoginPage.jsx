import React from "react";
import OwnerLogin from "../components/OwnerLogin";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white shadow rounded-xl p-6 w-full max-w-sm">
        <OwnerLogin />
      </div>
    </div>
  );
}
