using UnityEditor;

namespace AshesOfPantheon.QA.EditorBridge
{
    [InitializeOnLoad]
    internal static class QaBridgeBootstrap
    {
        private static QaBridgeServer m_server;

        static QaBridgeBootstrap()
        {
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            EditorApplication.delayCall += Start;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredPlayMode || state == PlayModeStateChange.EnteredEditMode)
            {
                Start();
            }
        }

        private static void Start()
        {
            if (m_server != null)
            {
                return;
            }

            QaMainThreadDispatcher.Install();
            m_server = new QaBridgeServer(new QaGameReflectionAdapter());
            m_server.Start();
        }

        private static void Stop()
        {
            m_server?.Dispose();
            m_server = null;
            QaMainThreadDispatcher.Uninstall();
        }
    }
}
