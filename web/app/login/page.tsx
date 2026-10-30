import { Suspense } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <AuthShell title="Sign in">
      {/* LoginForm reads ?next= and ?expired= from the URL. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
