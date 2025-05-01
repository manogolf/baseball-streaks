import PropTracker from "../components/PropTracker";
import PlayerPropsTable from "../components/PlayerPropsTable";
import PlayerPropForm from "../components/PlayerPropForm";

export default function PropsDashboard() {
  return (
    <div className="min-h-screen bg-gray-100 px-4 py-6">
      <div className="max-w-5xl mx-auto bg-white rounded-xl shadow p-6 space-y-6">
        <PropTracker />
        <PlayerPropsTable />
        <PlayerPropForm />
      </div>
    </div>
  );
}
