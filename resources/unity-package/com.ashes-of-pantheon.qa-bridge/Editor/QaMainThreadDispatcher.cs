using System;
using System.Collections.Concurrent;
using System.Threading;
using UnityEditor;

namespace AshesOfPantheon.QA.EditorBridge
{
    internal static class QaMainThreadDispatcher
    {
        private static readonly ConcurrentQueue<WorkItem> Pending = new ConcurrentQueue<WorkItem>();
        private static bool m_installed;

        public static void Install()
        {
            if (m_installed)
            {
                return;
            }

            m_installed = true;
            EditorApplication.update += Drain;
        }

        public static void Uninstall()
        {
            if (!m_installed)
            {
                return;
            }

            m_installed = false;
            EditorApplication.update -= Drain;
            while (Pending.TryDequeue(out var workItem))
            {
                workItem.Fail(new OperationCanceledException("QA bridge stopped."));
            }
        }

        public static object Invoke(Func<object> callback, int timeoutMilliseconds = 5000)
        {
            var workItem = new WorkItem(callback);
            Pending.Enqueue(workItem);
            if (!workItem.Wait(timeoutMilliseconds))
            {
                throw new TimeoutException("Unity main thread did not answer the QA request in time.");
            }

            if (workItem.Error != null)
            {
                throw workItem.Error;
            }

            return workItem.Result;
        }

        private static void Drain()
        {
            var processed = 0;
            while (processed < 32 && Pending.TryDequeue(out var workItem))
            {
                workItem.Execute();
                processed++;
            }
        }

        private sealed class WorkItem
        {
            private readonly Func<object> m_callback;
            private readonly ManualResetEventSlim m_completed = new ManualResetEventSlim(false);

            public WorkItem(Func<object> callback)
            {
                m_callback = callback;
            }

            public object Result { get; private set; }
            public Exception Error { get; private set; }

            public void Execute()
            {
                try
                {
                    Result = m_callback();
                }
                catch (Exception exception)
                {
                    Error = exception;
                }
                finally
                {
                    m_completed.Set();
                }
            }

            public void Fail(Exception exception)
            {
                Error = exception;
                m_completed.Set();
            }

            public bool Wait(int timeoutMilliseconds)
            {
                return m_completed.Wait(timeoutMilliseconds);
            }
        }
    }
}
