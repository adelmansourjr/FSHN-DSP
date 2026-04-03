import React from 'react';
import Constants from 'expo-constants';

const executionEnvironment = (Constants as any)?.executionEnvironment as
  | 'storeClient'
  | 'standalone'
  | 'bare'
  | undefined;

const isExpoGo = executionEnvironment === 'storeClient';

if (__DEV__) {
  console.log('[Stripe] env', {
    executionEnvironment,
    appOwnership: Constants.appOwnership,
  });
}

let stripeModule: typeof import('@stripe/stripe-react-native') | null = null;

function getStripeModule() {
  if (!stripeModule && !isExpoGo) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    stripeModule = require('@stripe/stripe-react-native');
  }
  return stripeModule;
}

type StripeProviderProps = React.ComponentProps<any> & {
  children?: React.ReactNode;
};

export function StripeProviderWrapper(props: StripeProviderProps) {
  if (isExpoGo) {
    return <>{props.children}</>;
  }

  const StripeProvider = getStripeModule()!.StripeProvider;
  return <StripeProvider {...props} />;
}

export function useStripeSafe(): {
  initPaymentSheet: (params: any) => Promise<{ error?: { message?: string } }>;
  presentPaymentSheet: () => Promise<{ error?: { message?: string } }>;
} {
  if (isExpoGo) {
    return {
      initPaymentSheet: async () => ({
        error: { message: 'Stripe is unavailable in Expo Go. Use a dev client build.' },
      }),
      presentPaymentSheet: async () => ({
        error: { message: 'Stripe is unavailable in Expo Go. Use a dev client build.' },
      }),
    };
  }

  const { useStripe } = getStripeModule()!;
  return useStripe();
}

export { isExpoGo };
