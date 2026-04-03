// App.tsx
import 'react-native-gesture-handler';
import './src/lib/firebase';
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar, Platform } from 'react-native';
import Root from './src/Root';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar
          barStyle={Platform.OS === 'ios' ? 'dark-content' : 'default'}
          translucent
          backgroundColor="transparent"
        />
        <Root />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}