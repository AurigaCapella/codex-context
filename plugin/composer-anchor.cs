using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;

public static class ComposerAnchor
{
    public static Task<string> ReadThreadAsync(IntPtr window, Dictionary<string, string> titles)
    {
        return Task.Run(() => ReadThread(window, titles));
    }

    private static string ReadThread(IntPtr window, Dictionary<string, string> titles)
    {
        var root = AutomationElement.FromHandle(window);
        if (root == null) return null;
        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
            new PropertyCondition(AutomationElement.ClassNameProperty, "ProseMirror"));
        AutomationElement composer = null;
        foreach (AutomationElement edit in root.FindAll(TreeScope.Descendants, condition))
        {
            if (edit.Current.IsOffscreen) continue;
            var node = edit;
            for (int depth = 0; depth < 6; depth++)
            {
                node = TreeWalker.RawViewWalker.GetParent(node);
                if (node == null) break;
                var props = node.Current;
                if (props.IsOffscreen) break;
                string cls = props.ClassName ?? "";
                if (cls != "ComposerLayoutBody" && !cls.StartsWith("ComposerLayoutBody-", StringComparison.Ordinal))
                    continue;
                Rect rect = props.BoundingRectangle;
                if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) break;
                if (composer != null) return null;
                composer = node;
                break;
            }
        }
        return composer == null ? null : FindActiveThread(root, FindConversationPane(composer), titles);
    }

    private static Rect FindConversationPane(AutomationElement node)
    {
        for (int depth = 0; depth < 14 && node != null; depth++)
        {
            var props = node.Current;
            if ((props.ClassName ?? "").Contains("group/thread-scroll-layout")) return props.BoundingRectangle;
            node = TreeWalker.RawViewWalker.GetParent(node);
        }
        return Rect.Empty;
    }

    private static string FindActiveThread(AutomationElement root, Rect pane, Dictionary<string, string> titles)
    {
        if (pane.IsEmpty) return null;
        string found = null;
        var toolbars = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ToolBar);
        var text = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text);
        foreach (AutomationElement bar in root.FindAll(TreeScope.Descendants, toolbars))
        {
            Rect area = bar.Current.BoundingRectangle;
            if (area.IsEmpty || bar.Current.IsOffscreen || area.Right < pane.Left || area.Left > pane.Right ||
                area.Top > pane.Top || area.Bottom < pane.Top - 220 || !IsTitlebarToolbar(bar)) continue;
            foreach (AutomationElement textElement in bar.FindAll(TreeScope.Descendants, text))
            {
                var props = textElement.Current;
                Rect rect = props.BoundingRectangle;
                if (rect.IsEmpty || props.IsOffscreen || rect.Left < pane.Left || rect.Right > pane.Right ||
                    rect.Bottom > pane.Top || rect.Bottom < pane.Top - 220) continue;
                string id;
                if (string.IsNullOrEmpty(props.Name) || !titles.TryGetValue(props.Name, out id) ||
                    string.IsNullOrEmpty(id)) continue;
                if (found != null && !string.Equals(found, id, StringComparison.Ordinal)) return null;
                found = id;
            }
        }
        return found;
    }

    private static bool IsTitlebarToolbar(AutomationElement bar)
    {
        var node = bar;
        for (int depth = 0; depth < 6 && node != null; depth++)
        {
            if ((node.Current.ClassName ?? "").Contains("group/titlebar")) return true;
            node = TreeWalker.RawViewWalker.GetParent(node);
        }
        return false;
    }
}
