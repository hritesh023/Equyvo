import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import EquyvoDeleteButton from '@/components/InteractDeleteButton';
import DeleteButton from '@/components/ui/DeleteButton';

const DeleteButtonDemo: React.FC = () => {
  const handleDelete = async () => {
    // Simulate delete operation
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('Item deleted successfully');
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Equyvo Custom Delete Button UI</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Standard Delete Button */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Standard</h3>
              <DeleteButton
                onDelete={handleDelete}
                variant="ghost"
                size="sm"
              />
            </div>

            {/* Destructive Variant */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Destructive</h3>
              <DeleteButton
                onDelete={handleDelete}
                variant="destructive"
                size="sm"
              />
            </div>

            {/* Outline Variant */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Outline</h3>
              <DeleteButton
                onDelete={handleDelete}
                variant="outline"
                size="sm"
              />
            </div>

            {/* Icon Only */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Icon Only</h3>
              <EquyvoDeleteButton
                onDelete={handleDelete}
                variant="ghost"
                size="icon"
                iconOnly={true}
              />
            </div>

            {/* Large Size */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Large</h3>
              <DeleteButton
                onDelete={handleDelete}
                variant="outline"
                size="lg"
              />
            </div>

            {/* Custom Text */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Custom Text</h3>
              <DeleteButton
                onDelete={handleDelete}
                variant="ghost"
                size="sm"
              >
                Remove Post
              </DeleteButton>
            </div>
          </div>

          <div className="mt-6 p-4 bg-muted/50 rounded-lg">
            <h3 className="text-sm font-medium mb-2">Features:</h3>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Custom Equyvo-branded design with red accent colors</li>
              <li>• Beautiful confirmation dialog with warning icon</li>
              <li>• Loading states with spinner animation</li>
              <li>• Multiple variants and sizes</li>
              <li>• Accessible and keyboard-friendly</li>
              <li>• Dark mode support</li>
              <li>• Smooth transitions and hover effects</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default DeleteButtonDemo;
