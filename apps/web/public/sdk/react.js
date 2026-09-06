const React = globalThis.__ZAPP_REACT__;
if (!React) throw new Error('Open Zapp before loading an extension');
export default React;
export const {createElement,cloneElement,isValidElement,Fragment,Children,Component,PureComponent,createContext,createRef,forwardRef,lazy,memo,startTransition,use,useActionState,useCallback,useContext,useDebugValue,useDeferredValue,useEffect,useId,useImperativeHandle,useInsertionEffect,useLayoutEffect,useMemo,useOptimistic,useReducer,useRef,useState,useSyncExternalStore,useTransition,version} = React;
