import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getPropDisplayLabel } from "../scripts/shared/propUtils.js";

export default function ModelAccuracyBarChart({ data }) {
  return (
    <div className="mt-6 h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
        >
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(val) => `${val}%`}
          />
          <YAxis
            type="category"
            dataKey="prop_type"
            width={160}
            tickFormatter={getPropDisplayLabel}
          />
          <Tooltip
            formatter={(value) => `${value.toFixed(1)}%`}
            labelFormatter={(label) => getPropDisplayLabel(label)}
          />
          <Bar
            dataKey="accuracy"
            name="Model Accuracy"
            fill="#00AA88"
            barSize={14}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
