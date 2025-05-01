import React from "react";

const StreaksTest = () => {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-center text-2xl font-bold text-gray-800 mb-1">
          🗓 Today’s Games
        </h2>
        <p className="text-center text-sm text-gray-500 mb-4">
          Live from MLB • ET and Local Time Displayed
        </p>

        {/* Game Card */}
        <ul className="divide-y divide-gray-200 border rounded-lg overflow-hidden bg-white shadow-sm">
          <li className="flex justify-between items-center px-4 py-3">
            {/* Away Team */}
            <div className="flex items-center gap-3 w-1/3">
              <img
                src="https://www.mlbstatic.com/team-logos/144.svg"
                alt="Braves"
                className="w-9 h-9 object-contain shrink-0"
              />
              <div className="leading-tight text-sm text-gray-800">
                <div className="font-semibold">Atlanta Braves</div>
                <div className="text-xs text-gray-500">Record: 13-15</div>
                <div className="text-xs text-gray-500">SP: Chris Sale</div>
              </div>
            </div>

            {/* Center Info */}
            <div className="text-center w-1/3 leading-snug">
              <div className="text-lg font-semibold">5 - 3</div>
              <div className="text-sm text-green-600">Final</div>
              <div className="text-xs text-gray-500">
                ET: 03:10 PM / Local: 12:10 PM
              </div>
            </div>

            {/* Home Team */}
            <div className="flex items-center gap-3 justify-end w-1/3 text-right">
              <div className="leading-tight text-sm text-gray-800">
                <div className="font-semibold">Colorado Rockies</div>
                <div className="text-xs text-gray-500">Record: 4-24</div>
                <div className="text-xs text-gray-500">SP: Chase Dollander</div>
              </div>
              <img
                src="https://www.mlbstatic.com/team-logos/115.svg"
                alt="Rockies"
                className="w-9 h-9 object-contain shrink-0"
              />
            </div>
          </li>
        </ul>
      </div>

      {/* Streaks Section */}
      <div className="pt-6 border-t">
        <h2 className="text-center text-2xl font-bold text-orange-700 mb-4">
          🔥 Streaks Dashboard
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Hot Streaks */}
          <div>
            <h3 className="text-lg font-semibold text-gray-700 mb-2">
              Hot Streaks 🔥
            </h3>
            <ul className="divide-y divide-gray-200 rounded-lg overflow-hidden border bg-white shadow-sm">
              <li className="p-3 leading-snug">
                <div className="font-medium">Byron Buxton (MIN)</div>
                <div className="text-sm text-gray-600">Walks</div>
                <div className="text-xs text-gray-500">W2</div>
              </li>
            </ul>
          </div>

          {/* Cold Streaks */}
          <div>
            <h3 className="text-lg font-semibold text-gray-700 mb-2">
              Cold Streaks ❄️
            </h3>
            <ul className="divide-y divide-gray-200 rounded-lg overflow-hidden border bg-white shadow-sm">
              <li className="p-3 leading-snug">
                <div className="font-medium">Brenton Doyle (COL)</div>
                <div className="text-sm text-gray-600">Hits</div>
                <div className="text-xs text-gray-500">L3</div>
              </li>
              <li className="p-3 leading-snug">
                <div className="font-medium">Kevin Pillar (TEX)</div>
                <div className="text-sm text-gray-600">Total Bases</div>
                <div className="text-xs text-gray-500">L2</div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StreaksTest;
