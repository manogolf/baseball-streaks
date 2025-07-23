import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../utils/supabaseFrontend.js";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const session = supabase.auth.session(); // ✅ v1.x correct usage
    setUser(session?.user ?? null);
    setLoading(false);

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        console.log("🔔 Auth listener triggered:", { session });
        setUser(session?.user ?? null);
      }
    );

    return () => {
      authListener?.unsubscribe(); // ✅ v1.x correct cleanup
    };
  }, []);

  const signIn = async ({ email, password }) => {
    const { error } = await supabase.auth.signIn({ email, password }); // ✅ v1.x syntax
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, signIn, signOut }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
