import { useEffect, useState } from "react";
import { Card, CardContent } from "../components/ui/card.js";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "../components/ui/table.js";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { getBaseUrl } from "../scripts/shared/getBaseUrl.js";

export default function ModelMetricsDashboard() {
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMetrics() {
      try {
        const res = await fetch(`${getBaseUrl()}/api/model-metrics`);
        const data = await res.json();
        setMetrics(data);
      } catch (error) {
        console.error("❌ Failed to load model metrics:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchMetrics();
  }, []);

  // ✅ Insert here
  if (loading) return <div className="p-4">Loading model metrics...</div>;
  if (!metrics.length) return <div className="p-4">No metrics available.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
      <Card>
        <CardContent>
          <h2 className="text-xl font-semibold mb-2">
            Overall Accuracy by Prop Type
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableCell>Prop Type</TableCell>
                <TableCell>Accuracy %</TableCell>
                <TableCell>Correct</TableCell>
                <TableCell>Total</TableCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((row) => (
                <TableRow key={row.prop_type}>
                  <TableCell>{row.prop_type}</TableCell>
                  <TableCell>
                    {typeof row.accuracy_pct === "number"
                      ? `${row.accuracy_pct.toFixed(1)}%`
                      : "N/A"}
                  </TableCell>
                  <TableCell>{row.correct}</TableCell>
                  <TableCell>{row.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-xl font-semibold mb-2">
            Bar Chart: Accuracy % by Prop
          </h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={metrics} layout="vertical">
              <XAxis
                type="number"
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis type="category" dataKey="prop_type" width={120} />
              <Tooltip formatter={(val) => `${val}%`} />
              <Bar dataKey="accuracy_pct" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
